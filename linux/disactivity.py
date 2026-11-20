#!/usr/bin/env python3
"""
Disactivity for Linux — Native GTK 4 + WebKitGTK 6.0 desktop host.

Serves the compiled Disactivity React frontend and implements the full Tauri v2
IPC surface (Discord detectable games API, favorites, cache, window controls,
authentic Linux ELF process simulation, and Discord Rich Presence IPC for
console/non-executable games like Grand Theft Auto VI).
"""

from __future__ import annotations

import atexit
from datetime import datetime, timezone
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("WebKit", "6.0")

from gi.repository import Gdk, Gio, GLib, Gtk, WebKit  # noqa: E402

DISCORD_GAMES_API_URL = "https://discord.com/api/v9/games/detectable"
DISCORD_NON_GAMES_API_URL = (
    "https://discord.com/api/v9/applications/non-games/detectable"
)
CACHE_FILE_NAME = "disactivity_games_cache.json"
CACHE_VERSION = 2
FAVORITES_FILE_NAME = "disactivity_favorites.json"
CACHE_EXPIRY_DAYS = 2
RESIZE_BORDER = 6

# Extra search aliases for popular games whose Discord entry omits common names
EXTRA_ALIASES: dict[str, list[str]] = {
    "1445160676522856458": ["GTA 6", "GTA VI", "gta6", "gtavi"],
}

APP_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = APP_DIR / "dist"


def get_cache_path() -> Path:
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / CACHE_FILE_NAME


def get_favorites_path() -> Path:
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "disactivity" / FAVORITES_FILE_NAME


def get_temp_root() -> Path:
    return Path(tempfile.gettempdir()) / "disactivity"


def find_slave_template() -> Path:
    """Locate a small native ELF binary that blocks cleanly on stdin EOF."""
    custom_slave = APP_DIR / "src-tauri" / "slave" / "target" / "release" / "slave"
    if custom_slave.is_file() and os.access(custom_slave, os.X_OK):
        return custom_slave
    for candidate in ("/usr/bin/cat", "/bin/cat"):
        p = Path(candidate)
        if p.is_file() and os.access(p, os.X_OK):
            return p
    found = shutil.which("cat")
    if found:
        return Path(found)
    raise RuntimeError("Could not locate a Linux ELF template binary (/usr/bin/cat)")


def find_discord_ipc_sockets() -> list[Path]:
    """Find active Discord Rich Presence Unix domain sockets on Linux."""
    dirs: list[Path] = []
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg:
        base = Path(xdg)
        dirs.extend(
            [
                base,
                base / "app" / "com.discordapp.Discord",
                base / "app" / "com.discordapp.DiscordCanary",
                base / "app" / "com.discordapp.DiscordPTB",
                base / "snap.discord",
            ]
        )
    dirs.append(Path(tempfile.gettempdir()))

    sockets: list[Path] = []
    for d in dirs:
        for i in range(10):
            candidate = d / f"discord-ipc-{i}"
            if candidate.exists():
                sockets.append(candidate)
    return sockets


class DiscordRpcSession:
    """Native Discord Local IPC Rich Presence session (no external deps)."""

    def __init__(self, app_id: str) -> None:
        self.app_id = app_id
        self.sock: socket.socket | None = None
        self._closed = threading.Event()
        self._lock = threading.Lock()
        self._connect_and_set()

    def _send_frame(self, opcode: int, payload: dict) -> None:
        assert self.sock is not None
        raw = json.dumps(payload).encode("utf-8")
        self.sock.sendall(struct.pack("<II", opcode, len(raw)) + raw)

    def _recv_exact(self, n: int) -> bytes:
        assert self.sock is not None
        buf = bytearray()
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("Discord IPC socket closed")
            buf.extend(chunk)
        return bytes(buf)

    def _recv_frame(self) -> tuple[int, dict]:
        hdr = self._recv_exact(8)
        op, length = struct.unpack("<II", hdr)
        body = self._recv_exact(length)
        return op, json.loads(body.decode("utf-8"))

    def _connect_and_set(self) -> None:
        sockets = find_discord_ipc_sockets()
        if not sockets:
            raise RuntimeError(
                "Discord is not running (no discord-ipc socket found). Open Discord first."
            )

        last_err: Exception | None = None
        for sock_path in sockets:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(5.0)
            try:
                s.connect(str(sock_path))
                self.sock = s
                self._send_frame(0, {"v": 1, "client_id": self.app_id})
                op, resp = self._recv_frame()
                if op == 2 or resp.get("evt") == "ERROR":
                    msg = resp.get("data", {}).get("message") or resp.get("message") or str(resp)
                    raise RuntimeError(f"Discord IPC handshake failed: {msg}")

                self._send_frame(
                    1,
                    {
                        "cmd": "SET_ACTIVITY",
                        "args": {
                            "pid": os.getpid(),
                            "activity": {
                                "timestamps": {"start": int(time.time())},
                            },
                        },
                        "nonce": str(uuid.uuid4()),
                    },
                )
                op2, resp2 = self._recv_frame()
                if op2 == 2 or resp2.get("evt") == "ERROR":
                    msg = resp2.get("data", {}).get("message") or str(resp2)
                    raise RuntimeError(f"Discord SET_ACTIVITY failed: {msg}")

                # Keep reading in background to respond to pings / detect disconnect
                s.settimeout(None)
                threading.Thread(target=self._pump_loop, daemon=True).start()
                return
            except Exception as exc:
                last_err = exc
                try:
                    s.close()
                except Exception:
                    pass
                self.sock = None

        raise RuntimeError(f"Failed to connect to Discord IPC: {last_err}")

    def _pump_loop(self) -> None:
        while not self._closed.is_set() and self.sock is not None:
            try:
                op, payload = self._recv_frame()
                if op == 3:  # PING -> PONG
                    with self._lock:
                        if self.sock and not self._closed.is_set():
                            self._send_frame(4, payload)
                elif op == 2:  # CLOSE
                    break
            except Exception:
                break
        self._closed.set()

    def is_alive(self) -> bool:
        return not self._closed.is_set() and self.sock is not None

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        with self._lock:
            s = self.sock
            self.sock = None
            if s is not None:
                try:
                    s.settimeout(1.5)
                    raw = json.dumps(
                        {
                            "cmd": "SET_ACTIVITY",
                            "args": {"pid": os.getpid(), "activity": None},
                            "nonce": str(uuid.uuid4()),
                        }
                    ).encode("utf-8")
                    s.sendall(struct.pack("<II", 1, len(raw)) + raw)
                except Exception:
                    pass
                try:
                    s.close()
                except Exception:
                    pass


class DisactivityBackend:
    """Cross-thread backend matching src-tauri/src/lib.rs behavior + Discord RPC."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._running_proc: dict[str, tuple[subprocess.Popen[bytes], Path]] = {}
        self._running_rpc: dict[str, DiscordRpcSession] = {}

    # --- Cache helpers ---
    def read_cache(self) -> dict | None:
        path = get_cache_path()
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("version") != CACHE_VERSION:
                return None
            return data
        except Exception:
            return None

    def write_cache(self, games: list[dict]) -> None:
        path = get_cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": CACHE_VERSION,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "games": games,
        }
        path.write_text(json.dumps(payload), encoding="utf-8")

    def is_cache_valid(self, cache: dict) -> bool:
        ts_raw = cache.get("timestamp")
        if not ts_raw:
            return False
        try:
            ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
            age = datetime.now(timezone.utc) - ts
            return age.days < CACHE_EXPIRY_DAYS
        except Exception:
            return False

    # --- Favorites helpers ---
    def read_favorites(self) -> set[str]:
        path = get_favorites_path()
        if not path.is_file():
            return set()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return set(str(x) for x in data)
        except Exception:
            pass
        return set()

    def write_favorites(self, favs: set[str]) -> None:
        path = get_favorites_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(sorted(favs)), encoding="utf-8")

    # --- Discord API ---
    def _http_get_json(self, url: str) -> list[dict]:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Disactivity/0.1.0",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status < 200 or resp.status >= 300:
                raise RuntimeError(f"API returned status: {resp.status}")
            return json.loads(resp.read().decode("utf-8"))

    def fetch_from_api(self) -> list[dict]:
        games = self._http_get_json(DISCORD_GAMES_API_URL)
        try:
            non_games = self._http_get_json(DISCORD_NON_GAMES_API_URL)
            if isinstance(non_games, list):
                games.extend(non_games)
        except Exception:
            pass

        seen: set[str] = set()
        result: list[dict] = []
        for g in games:
            gid = str(g.get("id", "")).strip()
            name = (g.get("name") or "").strip()
            if not gid or not name or gid in seen:
                continue
            seen.add(gid)

            aliases = list(g.get("aliases") or [])
            for extra in EXTRA_ALIASES.get(gid, ()):
                if extra not in aliases:
                    aliases.append(extra)

            result.append(
                {
                    "id": gid,
                    "name": name,
                    "icon_hash": g.get("icon_hash"),
                    "executables": g.get("executables") or [],
                    "aliases": aliases,
                }
            )
        return result

    def fetch_games(self, force_refresh: bool = False) -> dict:
        if not force_refresh:
            cache = self.read_cache()
            if cache and self.is_cache_valid(cache):
                return {"games": cache["games"], "from_cache": True}

        games = self.fetch_from_api()
        try:
            self.write_cache(games)
        except Exception as exc:
            print(f"Warning: Failed to write cache: {exc}", file=sys.stderr)
        return {"games": games, "from_cache": False}

    def get_cache_info(self) -> str | None:
        cache = self.read_cache()
        if not cache:
            return None
        return cache.get("timestamp")

    # --- Executable selection & spawning ---
    @staticmethod
    def select_best_executable(executables: list[dict]) -> str | None:
        def pick_for_os(target_os: str) -> str | None:
            candidates = [
                e["name"]
                for e in executables
                if e.get("os") == target_os
                and isinstance(e.get("name"), str)
                and not e["name"].startswith(">")
            ]
            if not candidates:
                return None
            return min(
                candidates,
                key=lambda name: (name.count("/") + name.count("\\"), len(name)),
            )

        return pick_for_os("linux") or pick_for_os("win32")

    @staticmethod
    def setup_game_executable(game_id: str, exe_path: str) -> tuple[Path, Path]:
        safe_id = "".join(c for c in game_id if c.isalnum() or c in ("-", "_")) or "game"
        temp_base = get_temp_root() / safe_id

        cleaned = exe_path.strip().strip('"').replace("\\", "/")
        parts = [p for p in cleaned.split("/") if p and p not in (".", "..")]
        if not parts:
            raise RuntimeError("Invalid executable path")

        full_dir = temp_base.joinpath(*parts[:-1]) if len(parts) > 1 else temp_base
        full_dir.mkdir(parents=True, exist_ok=True)
        final_exe_path = full_dir / parts[-1]

        template = find_slave_template()
        shutil.copy2(template, final_exe_path)
        os.chmod(final_exe_path, 0o755)
        return temp_base, final_exe_path

    @staticmethod
    def _cleanup_dir(path: Path) -> None:
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)

    def start_game(
        self,
        game_id: str,
        executables: list[dict],
        selected_executable: str | None = None,
    ) -> str:
        with self._lock:
            if game_id in self._running_proc:
                proc, _ = self._running_proc[game_id]
                if proc.poll() is None:
                    raise RuntimeError("Game is already running")
                self._running_proc.pop(game_id, None)
            if game_id in self._running_rpc:
                if self._running_rpc[game_id].is_alive():
                    raise RuntimeError("Game is already running")
                self._running_rpc.pop(game_id, None)

        use_rpc = selected_executable == "__discord_rpc__"
        exe_path = (
            None
            if use_rpc
            else (selected_executable or self.select_best_executable(executables))
        )

        # Fallback to Discord Rich Presence IPC when game has no PC executable (e.g. GTA VI)
        if use_rpc or not exe_path:
            session = DiscordRpcSession(game_id)
            with self._lock:
                self._running_rpc[game_id] = session
            return f"discord-rpc://{game_id}"

        temp_dir, final_exe_path = self.setup_game_executable(game_id, exe_path)
        try:
            proc = subprocess.Popen(
                [str(final_exe_path)],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                cwd=str(final_exe_path.parent),
            )
        except Exception as exc:
            self._cleanup_dir(temp_dir)
            raise RuntimeError(f"Failed to start process: {exc}") from exc

        with self._lock:
            self._running_proc[game_id] = (proc, temp_dir)
        return str(final_exe_path)

    def stop_game(self, game_id: str) -> None:
        with self._lock:
            proc_entry = self._running_proc.pop(game_id, None)
            rpc_session = self._running_rpc.pop(game_id, None)
        if proc_entry:
            proc, temp_dir = proc_entry
            self._terminate_process(proc)
            self._cleanup_dir(temp_dir)
        if rpc_session:
            rpc_session.close()

    def get_running_games(self) -> list[str]:
        with self._lock:
            alive = []
            dead_procs = []
            for gid, (proc, temp_dir) in self._running_proc.items():
                if proc.poll() is None:
                    alive.append(gid)
                else:
                    dead_procs.append((gid, temp_dir))
            for gid, temp_dir in dead_procs:
                self._running_proc.pop(gid, None)
                self._cleanup_dir(temp_dir)

            dead_rpcs = []
            for gid, session in self._running_rpc.items():
                if session.is_alive():
                    alive.append(gid)
                else:
                    dead_rpcs.append(gid)
            for gid in dead_rpcs:
                self._running_rpc.pop(gid, None)
            return alive

    def get_favorites(self) -> list[str]:
        return sorted(self.read_favorites())

    def add_favorite(self, game_id: str) -> None:
        favs = self.read_favorites()
        favs.add(game_id)
        self.write_favorites(favs)

    def remove_favorite(self, game_id: str) -> None:
        favs = self.read_favorites()
        favs.discard(game_id)
        self.write_favorites(favs)

    def toggle_favorite(self, game_id: str) -> bool:
        favs = self.read_favorites()
        if game_id in favs:
            favs.remove(game_id)
            is_fav = False
        else:
            favs.add(game_id)
            is_fav = True
        self.write_favorites(favs)
        return is_fav

    @staticmethod
    def _terminate_process(proc: subprocess.Popen[bytes]) -> None:
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:
            pass
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=2)
        except Exception:
            pass

    def cleanup_all(self) -> None:
        with self._lock:
            proc_entries = list(self._running_proc.values())
            self._running_proc.clear()
            rpc_sessions = list(self._running_rpc.values())
            self._running_rpc.clear()
        for session in rpc_sessions:
            session.close()
        for proc, temp_dir in proc_entries:
            self._terminate_process(proc)
            self._cleanup_dir(temp_dir)
        self._cleanup_dir(get_temp_root())


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass


def start_static_server(directory: Path) -> tuple[ThreadingHTTPServer, int]:
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    mimetypes.add_type("font/woff2", ".woff2")
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


TAURI_BRIDGE_JS = r"""
(() => {
    window.__DISACTIVITY_LINUX__ = true;
    let nextId = 1;
    const pending = new Map();
    const callbacks = new Map();

    window.__disactivityResolve = (id, ok, payload) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (ok) {
            entry.resolve(payload);
        } else {
            entry.reject(payload);
        }
    };

    window.__TAURI_INTERNALS__ = {
        metadata: {
            currentWindow: { label: "main" },
            currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback(callback, once = false) {
            const id = Math.floor(Math.random() * 0x7fffffff);
            callbacks.set(id, (data) => {
                if (once) callbacks.delete(id);
                if (callback) callback(data);
            });
            return id;
        },
        unregisterCallback(id) {
            callbacks.delete(id);
        },
        convertFileSrc(path) {
            return path;
        },
        invoke(cmd, args = {}) {
            return new Promise((resolve, reject) => {
                const id = nextId++;
                pending.set(id, { resolve, reject });
                try {
                    window.webkit.messageHandlers.disactivity.postMessage(
                        JSON.stringify({ id, cmd, args })
                    );
                } catch (err) {
                    pending.delete(id);
                    reject(String(err));
                }
            });
        },
    };
})();
"""


class DisactivityApp(Gtk.Application):
    def __init__(self, backend: DisactivityBackend, url: str) -> None:
        super().__init__(
            application_id="com.holasoyender.disactivity",
            flags=Gio.ApplicationFlags.FLAGS_NONE,
        )
        self.backend = backend
        self.url = url
        self.window: Gtk.ApplicationWindow | None = None
        self.webview: WebKit.WebView | None = None
        self._last_press: tuple | None = None

    def do_activate(self) -> None:
        if self.window is not None:
            self.window.present()
            return

        win = Gtk.ApplicationWindow(application=self)
        win.set_title("Disactivity")
        win.set_default_size(650, 800)
        win.set_size_request(420, 520)
        win.set_decorated(False)
        win.set_resizable(True)
        win.connect("close-request", self._on_close_request)

        ucm = WebKit.UserContentManager()
        ucm.add_script(
            WebKit.UserScript(
                TAURI_BRIDGE_JS,
                WebKit.UserContentInjectedFrames.TOP_FRAME,
                WebKit.UserScriptInjectionTime.START,
                None,
                None,
            )
        )
        ucm.register_script_message_handler("disactivity", None)
        ucm.connect("script-message-received::disactivity", self._on_js_message)

        webview = WebKit.WebView(user_content_manager=ucm)
        settings = webview.get_settings()
        settings.set_enable_developer_extras(False)
        webview.set_vexpand(True)
        webview.set_hexpand(True)

        click_gesture = Gtk.GestureClick()
        click_gesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        click_gesture.connect("pressed", self._on_pointer_pressed)
        win.add_controller(click_gesture)

        win.set_child(webview)
        webview.load_uri(self.url)

        self.window = win
        self.webview = webview
        win.present()

    def _detect_resize_edge(self, x: float, y: float) -> Gdk.SurfaceEdge | None:
        if not self.window or self.window.is_maximized():
            return None
        w = self.window.get_width()
        h = self.window.get_height()
        left = x < RESIZE_BORDER
        right = x > w - RESIZE_BORDER
        top = y < RESIZE_BORDER
        bottom = y > h - RESIZE_BORDER
        if top and left:
            return Gdk.SurfaceEdge.NORTH_WEST
        if top and right:
            return Gdk.SurfaceEdge.NORTH_EAST
        if bottom and left:
            return Gdk.SurfaceEdge.SOUTH_WEST
        if bottom and right:
            return Gdk.SurfaceEdge.SOUTH_EAST
        if left:
            return Gdk.SurfaceEdge.WEST
        if right:
            return Gdk.SurfaceEdge.EAST
        if top:
            return Gdk.SurfaceEdge.NORTH
        if bottom:
            return Gdk.SurfaceEdge.SOUTH
        return None

    def _on_pointer_pressed(
        self, gesture: Gtk.GestureClick, _n_press: int, x: float, y: float
    ) -> None:
        device = gesture.get_device()
        button = gesture.get_current_button()
        ts = gesture.get_current_event_time()
        self._last_press = (device, button, x, y, ts)

        if button == 1 and self.window is not None:
            edge = self._detect_resize_edge(x, y)
            if edge is not None:
                surface = self.window.get_surface()
                if surface is not None and device is not None:
                    surface.begin_resize(edge, device, button, x, y, ts)

    def _on_close_request(self, _win: Gtk.Window) -> bool:
        self.backend.cleanup_all()
        return False

    def _send_js_result(self, req_id: int, ok: bool, payload) -> None:
        if self.webview is None:
            return
        script = (
            f"window.__disactivityResolve("
            f"{req_id}, {'true' if ok else 'false'}, {json.dumps(payload)});"
        )
        self.webview.evaluate_javascript(script, -1, None, None, None, None, None)

    def _on_js_message(self, _ucm: WebKit.UserContentManager, js_val) -> None:
        try:
            msg = json.loads(js_val.to_string())
        except Exception:
            return
        req_id = int(msg.get("id", 0))
        cmd = msg.get("cmd", "")
        args = msg.get("args") or {}

        if cmd.startswith("plugin:window|"):
            try:
                res = self._handle_window_cmd(cmd)
                self._send_js_result(req_id, True, res)
            except Exception as exc:
                self._send_js_result(req_id, False, str(exc))
            return

        if cmd == "plugin:updater|check":
            self._send_js_result(req_id, True, None)
            return

        if cmd in ("plugin:process|exit", "plugin:process|restart"):
            self._send_js_result(req_id, True, None)
            self.backend.cleanup_all()
            if self.window:
                self.window.close()
            return

        threading.Thread(
            target=self._run_backend_cmd,
            args=(req_id, cmd, args),
            daemon=True,
        ).start()

    def _handle_window_cmd(self, cmd: str):
        win = self.window
        if win is None:
            return None
        if cmd == "plugin:window|minimize":
            win.minimize()
        elif cmd == "plugin:window|maximize":
            win.maximize()
        elif cmd == "plugin:window|unmaximize":
            win.unmaximize()
        elif cmd == "plugin:window|toggle_maximize":
            if win.is_maximized():
                win.unmaximize()
            else:
                win.maximize()
        elif cmd == "plugin:window|is_maximized":
            return bool(win.is_maximized())
        elif cmd == "plugin:window|close":
            self.backend.cleanup_all()
            win.close()
        elif cmd == "plugin:window|start_dragging":
            if self._last_press is not None:
                device, button, x, y, ts = self._last_press
                surface = win.get_surface()
                if surface is not None and device is not None:
                    surface.begin_move(device, button, x, y, ts)
        return None

    def _run_backend_cmd(self, req_id: int, cmd: str, args: dict) -> None:
        try:
            if cmd == "fetch_games":
                result = self.backend.fetch_games(
                    bool(args.get("forceRefresh", False))
                )
            elif cmd == "get_cache_info":
                result = self.backend.get_cache_info()
            elif cmd == "start_game":
                result = self.backend.start_game(
                    str(args["gameId"]),
                    list(args.get("executables") or []),
                    args.get("selectedExecutable"),
                )
            elif cmd == "stop_game":
                self.backend.stop_game(str(args["gameId"]))
                result = None
            elif cmd == "get_running_games":
                result = self.backend.get_running_games()
            elif cmd == "get_favorites":
                result = self.backend.get_favorites()
            elif cmd == "add_favorite":
                self.backend.add_favorite(str(args["gameId"]))
                result = None
            elif cmd == "remove_favorite":
                self.backend.remove_favorite(str(args["gameId"]))
                result = None
            elif cmd == "toggle_favorite":
                result = self.backend.toggle_favorite(str(args["gameId"]))
            else:
                raise RuntimeError(f"Unsupported command: {cmd}")
            GLib.idle_add(self._send_js_result, req_id, True, result)
        except Exception as exc:
            GLib.idle_add(self._send_js_result, req_id, False, str(exc))


def run_self_test() -> int:
    backend = DisactivityBackend()
    try:
        assert (
            backend.select_best_executable(
                [
                    {"name": "game.exe", "os": "win32"},
                    {"name": "bin/game_linux", "os": "linux"},
                ]
            )
            == "bin/game_linux"
        )
        assert (
            backend.select_best_executable(
                [
                    {"name": ">ignore.exe", "os": "win32"},
                    {"name": "sub/game.exe", "os": "win32"},
                    {"name": "game.exe", "os": "win32"},
                ]
            )
            == "game.exe"
        )

        exe_path = backend.start_game(
            "selftest123",
            [{"name": "_ptr_/wow-64.exe", "os": "win32"}],
            None,
        )
        assert "selftest123" in backend.get_running_games()
        proc, temp_dir = backend._running_proc["selftest123"]
        proc_exe = os.readlink(f"/proc/{proc.pid}/exe")
        proc_cmdline = Path(f"/proc/{proc.pid}/cmdline").read_bytes()
        assert proc_exe == exe_path, f"exe mismatch: {proc_exe} != {exe_path}"
        assert proc_cmdline == (exe_path.encode() + b"\x00"), f"cmdline mismatch: {proc_cmdline!r}"

        backend.stop_game("selftest123")
        assert "selftest123" not in backend.get_running_games()
        assert not temp_dir.exists()
        print("SELF-TEST OK:", exe_path)
        return 0
    finally:
        backend.cleanup_all()


def main() -> int:
    if "--self-test" in sys.argv:
        return run_self_test()

    if not (DIST_DIR / "index.html").is_file():
        print(
            f"Error: Built frontend not found at {DIST_DIR}. Run `npm run build` first.",
            file=sys.stderr,
        )
        return 1

    backend = DisactivityBackend()
    atexit.register(backend.cleanup_all)

    def _handle_signal(_signum, _frame) -> None:
        backend.cleanup_all()
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    server, port = start_static_server(DIST_DIR)
    url = f"http://127.0.0.1:{port}/index.html"

    app = DisactivityApp(backend, url)
    try:
        return app.run(sys.argv)
    finally:
        backend.cleanup_all()
        server.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
