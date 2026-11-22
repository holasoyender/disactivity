use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

const DISCORD_GAMES_API_URL: &str = "https://discord.com/api/v9/games/detectable";
const DISCORD_NON_GAMES_API_URL: &str = "https://discord.com/api/v9/applications/non-games/detectable";

// v2 invalidates the old cache, which filtered Steam-only catalog entries out.
const CACHE_FILE_NAME: &str = "disactivity_games_cache_v2.json";
const FAVORITES_FILE_NAME: &str = "disactivity_favorites.json";
const CACHE_EXPIRY_DAYS: i64 = 2;

// Embedded slave executable bytes (built in release mode)
const SLAVE_EXE: &[u8] = include_bytes!("../slave/target/release/slave.exe");

/// Tracks a running game process
struct RunningGame {
    process: Child,
    temp_dir: PathBuf,
}

struct SteamCleanup {
    paths: Vec<PathBuf>,
    index: Option<(PathBuf, u32)>,
    empty_game_dir: Option<PathBuf>,
}

/// State to track all running game processes
struct AppState {
    running_games: Mutex<HashMap<String, RunningGame>>,
    steam_installs: Mutex<HashMap<String, SteamCleanup>>,
}

static STEAM_INDEX_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Executable {
    pub name: String,
    #[serde(default)]
    pub os: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Game {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon_hash: Option<String>,
    #[serde(default)]
    pub executables: Option<Vec<Executable>>,
    pub aliases: Vec<String>,
    #[serde(default)]
    pub third_party_skus: Vec<GameSku>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GameSku {
    pub id: Option<String>,
    pub sku: Option<String>,
    pub distributor: String,
}

impl Game {
    fn steam_app_id(&self) -> Option<u32> {
        self.third_party_skus.iter().find(|sku| sku.distributor == "steam")
            .and_then(|sku| sku.id.as_ref().or(sku.sku.as_ref()))
            .and_then(|id| id.parse().ok())
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheData {
    timestamp: DateTime<Utc>,
    games: Vec<Game>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FetchGamesResponse {
    pub games: Vec<Game>,
    pub from_cache: bool,
}

#[derive(Debug, Serialize)]
struct StartGameResponse {
    path: String,
    needs_discord_restart: bool,
}

fn get_cache_path() -> Option<PathBuf> {
    dirs::cache_dir().map(|p| p.join(CACHE_FILE_NAME))
}

fn read_cache() -> Option<CacheData> {
    let cache_path = get_cache_path()?;
    let content = fs::read_to_string(&cache_path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_cache(games: &[Game]) -> Result<(), String> {
    let cache_path = get_cache_path().ok_or("Could not determine cache directory")?;
    let cache_data = CacheData {
        timestamp: Utc::now(),
        games: games.to_vec(),
    };
    let content = serde_json::to_string(&cache_data).map_err(|e| e.to_string())?;
    fs::write(&cache_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

fn is_cache_valid(cache: &CacheData) -> bool {
    let now = Utc::now();
    let cache_age = now.signed_duration_since(cache.timestamp);
    cache_age.num_days() < CACHE_EXPIRY_DAYS
}

// Favorites functions
fn get_favorites_path() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("disactivity").join(FAVORITES_FILE_NAME))
}

fn read_favorites() -> HashSet<String> {
    let Some(path) = get_favorites_path() else {
        return HashSet::new();
    };

    let Ok(content) = fs::read_to_string(&path) else {
        return HashSet::new();
    };

    serde_json::from_str(&content).unwrap_or_default()
}

fn write_favorites(favorites: &HashSet<String>) -> Result<(), String> {
    let path = get_favorites_path().ok_or("Could not determine config directory")?;

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let content = serde_json::to_string(favorites).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

async fn fetch_from_api() -> Result<Vec<Game>, String> {
    let client = reqwest::Client::new();
    let response_games = client
        .get(DISCORD_GAMES_API_URL)
        .header("User-Agent", "Disactivity/0.1.0")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch games: {}", e))?;

    if !response_games.status().is_success() {
        return Err(format!("API returned status: {}", response_games.status()));
    }

    let response_non_games = client
        .get(DISCORD_NON_GAMES_API_URL)
        .header("User-Agent", "Disactivity/0.1.0")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch games: {}", e))?;

    let mut games: Vec<Game> = response_games
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if response_non_games.status().is_success() {
        let non_games: Vec<Game> = response_non_games
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;
        games.extend(non_games);
    }

    Ok(games.into_iter().filter(|game| {
        game.executables.as_ref().map_or(false, |execs| !execs.is_empty()) || game.steam_app_id().is_some()
    }).collect())
}

#[tauri::command]
async fn fetch_games(force_refresh: bool) -> Result<FetchGamesResponse, String> {
    // Check cache first if not forcing refresh
    if !force_refresh {
        if let Some(cache) = read_cache() {
            if is_cache_valid(&cache) {
                return Ok(FetchGamesResponse {
                    games: cache.games,
                    from_cache: true,
                });
            }
        }
    }

    // Fetch from API
    let games = fetch_from_api().await?;

    // Write to cache
    if let Err(e) = write_cache(&games) {
        eprintln!("Warning: Failed to write cache: {}", e);
    }

    Ok(FetchGamesResponse {
        games,
        from_cache: false,
    })
}

#[tauri::command]
fn get_cache_info() -> Option<String> {
    let cache = read_cache()?;
    Some(cache.timestamp.to_rfc3339())
}

/// Select the best executable for win32 platform
/// Filters by os == "win32", excludes paths starting with ">", and picks shortest path
fn select_best_executable(executables: &[Executable]) -> Option<String> {
    executables
        .iter()
        .filter(|exe| {
            // Must be win32
            exe.os.as_deref() == Some("win32")
            // Must not start with ">" (which indicates "starts with" pattern)
            && !exe.name.starts_with('>')
        })
        .min_by_key(|exe| {
            // Pick the one with fewest path separators, then shortest length
            let separators = exe.name.matches('/').count() + exe.name.matches('\\').count();
            (separators, exe.name.len())
        })
        .map(|exe| exe.name.clone())
}

/// Create the directory structure and place the slave executable
fn setup_game_executable(game_id: &str, exe_path: &str) -> Result<(PathBuf, PathBuf), String> {
    // Get system temp directory
    let temp_base = std::env::temp_dir().join("disactivity").join(game_id);

    // Parse the executable path and create directory structure
    // exe_path might be something like "path/to/game.exe" or just "game.exe"
    let exe_path_normalized = exe_path.replace('\\', "/");
    let path_parts: Vec<&str> = exe_path_normalized.split('/').collect();

    // Create the full path including directories
    let mut full_dir = temp_base.clone();
    for part in &path_parts[..path_parts.len().saturating_sub(1)] {
        if !part.is_empty() {
            full_dir = full_dir.join(part);
        }
    }

    // Create all directories
    fs::create_dir_all(&full_dir).map_err(|e| format!("Failed to create directories: {}", e))?;

    // Get the executable filename
    let exe_filename = path_parts.last().ok_or("Invalid executable path")?;
    let final_exe_path = full_dir.join(exe_filename);

    // Write the slave executable
    fs::write(&final_exe_path, SLAVE_EXE)
        .map_err(|e| format!("Failed to write executable: {}", e))?;

    Ok((temp_base, final_exe_path))
}

fn find_steam_root() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(p) = std::env::var_os("ProgramFiles(x86)") { candidates.push(PathBuf::from(p).join("Steam")); }
    if let Some(p) = std::env::var_os("ProgramFiles") { candidates.push(PathBuf::from(p).join("Steam")); }
    if let Some(p) = std::env::var_os("LOCALAPPDATA") { candidates.push(PathBuf::from(p).join("Programs/Steam")); }
    if let Ok(output) = Command::new("reg").args(["query", r"HKCU\Software\Valve\Steam", "/v", "SteamPath"]).output() {
        let text = String::from_utf8_lossy(&output.stdout);
        if let Some(path) = text.lines().find(|line| line.contains("SteamPath"))
            .and_then(|line| line.split_whitespace().last()) {
            candidates.push(PathBuf::from(path.replace('/', "\\")));
        }
    }
    candidates.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    candidates.into_iter().find(|p| p.join("steamapps").join("libraryfolders.vdf").is_file())
        .ok_or_else(|| "Steam was not found in the standard Windows locations".to_string())
}

fn add_steam_library_index(path: &PathBuf, app_id: u32) -> Result<bool, String> {
    let _lock = STEAM_INDEX_LOCK.lock().map_err(|e| e.to_string())?;
    let mut content = fs::read_to_string(path).map_err(|e| format!("Could not read Steam library index: {e}"))?;
    let marker = "\"apps\"";
    let key = format!("\"{app_id}\"");
    let Some(apps_at) = content.find(marker) else { return Err("Steam library index has an unsupported format".into()); };
    let open = content[apps_at + marker.len()..].find('{').map(|i| apps_at + marker.len() + i)
        .ok_or("Steam library index has an invalid apps section")?;
    let mut depth = 0i32;
    let mut quoted = false;
    let mut escaped = false;
    let mut close = None;
    for (offset, byte) in content.as_bytes().iter().enumerate().skip(open) {
        if quoted {
            if escaped { escaped = false; }
            else if *byte == b'\\' { escaped = true; }
            else if *byte == b'"' { quoted = false; }
        } else if *byte == b'"' { quoted = true; }
        else if *byte == b'{' { depth += 1; }
        else if *byte == b'}' { depth -= 1; if depth == 0 { close = Some(offset); break; } }
    }
    let close = close.ok_or("Steam library index has unbalanced braces")?;
    let section = &content[open + 1..close];
    if section.lines().any(|line| line.trim_start().starts_with(&key)) { return Ok(false); }
    content.insert_str(close, &format!("\n\t\t\t{key}\t\"0\""));
    fs::write(path, content).map_err(|e| format!("Could not update Steam library index: {e}"))?;
    Ok(true)
}

fn remove_steam_library_index(path: &PathBuf, app_id: u32) {
    let Ok(_lock) = STEAM_INDEX_LOCK.lock() else { return; };
    if let Ok(content) = fs::read_to_string(path) {
        let key = format!("\"{app_id}\"");
        let updated = content.split_inclusive('\n')
            .filter(|line| !line.trim_start().starts_with(&key))
            .fold(String::new(), |mut output, line| { output.push_str(line); output });
        let _ = fs::write(path, updated);
    }
}

fn setup_steam_executable(app_id: u32, game_name: &str) -> Result<(PathBuf, PathBuf, Vec<PathBuf>, Option<(PathBuf, u32)>, Option<PathBuf>), String> {
    let root = find_steam_root()?;
    let steamapps = root.join("steamapps");
    let manifest = steamapps.join(format!("appmanifest_{app_id}.acf"));
    let (game_dir, cleanup_paths) = if manifest.exists() {
        let contents = fs::read_to_string(&manifest).map_err(|e| format!("Could not read Steam game manifest: {e}"))?;
        let install_dir = contents.lines().find_map(|line| {
            let rest = line.trim().strip_prefix("\"installdir\"")?.trim();
            let value = rest.trim_matches('"');
            (!value.is_empty() && !value.contains('/') && !value.contains('\\') && value != "." && value != "..").then(|| value.to_string())
        }).ok_or("Steam manifest has no safe install directory")?;
        (steamapps.join("common").join(install_dir), Vec::new())
    } else {
        let install_dir = format!("Disactivity_{app_id}");
        let game_dir = steamapps.join("common").join(&install_dir);
        let safe_name: String = game_name.chars().filter(|c| !matches!(c, '"' | '\n' | '\r')).collect();
        let acf = format!("\"AppState\"\n{{\n\t\"appid\"\t\"{app_id}\"\n\t\"universe\"\t\"1\"\n\t\"name\"\t\"{safe_name}\"\n\t\"StateFlags\"\t\"4\"\n\t\"installdir\"\t\"{install_dir}\"\n\t\"AutoUpdateBehavior\"\t\"1\"\n}}\n");
        fs::write(&manifest, acf).map_err(|e| format!("Failed to register Steam game: {e}"))?;
        (game_dir, vec![manifest])
    };
    let library_index = steamapps.join("libraryfolders.vdf");
    let index_added = match add_steam_library_index(&library_index, app_id) {
        Ok(added) => added,
        Err(error) => { for path in &cleanup_paths { let _ = fs::remove_file(path); } return Err(error); }
    };
    let temp_dir = game_dir.join("_disactivity");
    let game_dir_was_missing = !game_dir.exists();
    if let Err(e) = fs::create_dir_all(&temp_dir) {
        if index_added { remove_steam_library_index(&library_index, app_id); }
        for path in &cleanup_paths { let _ = fs::remove_file(path); }
        return Err(format!("Failed to create Steam game directory: {e}"));
    }
    let exe_path = temp_dir.join("game.exe");
    if let Err(e) = fs::write(&exe_path, SLAVE_EXE) {
        let _ = fs::remove_dir_all(&temp_dir);
        if game_dir_was_missing { let _ = fs::remove_dir(&game_dir); }
        if index_added { remove_steam_library_index(&library_index, app_id); }
        for path in &cleanup_paths { let _ = fs::remove_file(path); }
        return Err(format!("Failed to write Steam activity process: {e}"));
    }
    // Existing installs keep their manifest intact. For uninstalled titles only the
    // temporary manifest and isolated folder created above are removed on stop.
    Ok((temp_dir, exe_path, cleanup_paths, if index_added { Some((library_index, app_id)) } else { None }, if game_dir_was_missing { Some(game_dir) } else { None }))
}

/// Clean up a game's temp directory
fn cleanup_game(temp_dir: &PathBuf) -> Result<(), String> {
    if temp_dir.exists() {
        fs::remove_dir_all(temp_dir).map_err(|e| format!("Failed to cleanup: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn start_game(
    game_id: String,
    executables: Vec<Executable>,
    selected_executable: Option<String>,
    steam_app_id: Option<u32>,
    game_name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<StartGameResponse, String> {
    // Check if game is already running
    {
        let running = state.running_games.lock().map_err(|e| e.to_string())?;
        if running.contains_key(&game_id) {
            return Err("Game is already running".to_string());
        }
    }

    // Use the selected executable if provided, otherwise auto-select the best one
    let (temp_dir, final_exe_path, cleanup_paths, steam_index, empty_game_dir) = if let Some(app_id) = steam_app_id {
        let (dir, exe, cleanup, index, parent) = setup_steam_executable(app_id, game_name.as_deref().unwrap_or("Game"))?;
        (dir, exe, cleanup, index, parent)
    } else {
        let exe_path = selected_executable.or_else(|| select_best_executable(&executables))
            .ok_or("This game needs Steam library mode or has no suitable Windows executable")?;
        let (dir, exe) = setup_game_executable(&game_id, &exe_path)?;
        (dir, exe, Vec::new(), None, None)
    };

    let needs_discord_restart = steam_index.is_some();

    // Start the process
    let process = Command::new(&final_exe_path)
        .spawn()
        .map_err(|e| {
            // Cleanup on failure
            for path in &cleanup_paths { let _ = fs::remove_file(path); }
            if let Some((path, app_id)) = &steam_index { remove_steam_library_index(path, *app_id); }
            let _ = cleanup_game(&temp_dir);
            if let Some(path) = &empty_game_dir { let _ = fs::remove_dir(path); }
            format!("Failed to start process: {}", e)
        })?;

    // Keep Steam registration while this app remains open. Discord scans Steam on
    // startup, so removing it on every Stop would force another Discord restart.
    if !cleanup_paths.is_empty() || steam_index.is_some() || empty_game_dir.is_some() {
        if let Ok(mut installs) = state.steam_installs.lock() {
            installs.entry(game_id.clone()).or_insert(SteamCleanup {
                paths: cleanup_paths,
                index: steam_index,
                empty_game_dir,
            });
        }
    }

    // Store the running game
    let mut running = state.running_games.lock().map_err(|e| e.to_string())?;
    running.insert(
        game_id.clone(),
        RunningGame {
            process,
            temp_dir,
        },
    );

    Ok(StartGameResponse {
        path: final_exe_path.to_string_lossy().to_string(),
        needs_discord_restart,
    })
}

#[tauri::command]
fn stop_game(game_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut running = state.running_games.lock().map_err(|e| e.to_string())?;

    if let Some(mut game) = running.remove(&game_id) {
        // Kill the process
        let _ = game.process.kill();
        let _ = game.process.wait();
        // Cleanup temp directory
        cleanup_game(&game.temp_dir)?;
    }

    Ok(())
}

#[tauri::command]
fn get_running_games(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let running = state.running_games.lock().map_err(|e| e.to_string())?;
    Ok(running.keys().cloned().collect())
}

#[tauri::command]
fn get_favorites() -> Vec<String> {
    read_favorites().into_iter().collect()
}

#[tauri::command]
fn add_favorite(game_id: String) -> Result<(), String> {
    let mut favorites = read_favorites();
    favorites.insert(game_id);
    write_favorites(&favorites)
}

#[tauri::command]
fn remove_favorite(game_id: String) -> Result<(), String> {
    let mut favorites = read_favorites();
    favorites.remove(&game_id);
    write_favorites(&favorites)
}

#[tauri::command]
fn toggle_favorite(game_id: String) -> Result<bool, String> {
    let mut favorites = read_favorites();
    let is_favorite = if favorites.contains(&game_id) {
        favorites.remove(&game_id);
        false
    } else {
        favorites.insert(game_id);
        true
    };
    write_favorites(&favorites)?;
    Ok(is_favorite)
}

/// Stop all running games and cleanup
fn cleanup_all_games(state: &AppState) {
    if let Ok(mut running) = state.running_games.lock() {
        for (_, mut game) in running.drain() {
            let _ = game.process.kill();
            let _ = game.process.wait();
            let _ = cleanup_game(&game.temp_dir);
        }
    }

    if let Ok(mut installs) = state.steam_installs.lock() {
        for (_, install) in installs.drain() {
            for path in &install.paths { let _ = fs::remove_file(path); }
            if let Some((path, app_id)) = &install.index { remove_steam_library_index(path, *app_id); }
            if let Some(path) = &install.empty_game_dir { let _ = fs::remove_dir(path); }
        }
    }

    // Also cleanup the base disactivity temp directory if it exists
    let temp_base = std::env::temp_dir().join("disactivity");
    if temp_base.exists() {
        let _ = fs::remove_dir_all(&temp_base);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            running_games: Mutex::new(HashMap::new()),
            steam_installs: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            fetch_games,
            get_cache_info,
            start_game,
            stop_game,
            get_running_games,
            get_favorites,
            add_favorite,
            remove_favorite,
            toggle_favorite
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Cleanup all games when window is closed
                if let Some(state) = window.try_state::<AppState>() {
                    cleanup_all_games(state.inner());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
