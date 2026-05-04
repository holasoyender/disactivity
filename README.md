<p align="center">
  <img src="public/icon.png" alt="Disactivity Logo" width="128" height="128">
</p>

<h1 align="center">Disactivity</h1>

<p align="center">
  <strong>Discord Activity Simulator</strong><br>
  Simulate game activity on Discord by running fake game processes that Discord can detect.
</p>

<p align="center">
  <a href="https://github.com/holasoyender/disactivity/releases/latest">
    <img src="https://img.shields.io/github/v/release/holasoyender/disactivity?style=flat-square" alt="Latest Release">
  </a>
  <a href="https://github.com/holasoyender/disactivity/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/holasoyender/disactivity?style=flat-square" alt="License">
  </a>
</p>

---

## 📖 Description

**Disactivity** is a lightweight desktop application that allows you to simulate playing any game on Discord. Simply select a game from the list, click "Run", and Discord will display that you're playing the selected game - without actually having it installed.

The app fetches the complete list of detectable games directly from Discord's API, so you have access to thousands of games to choose from.

<p align="center">
  <img src="public/banner.png" alt="Disactivity Logo">
</p>

## ✨ Features

- 🎮 **Thousands of Games** - Browse and search through Discord's complete detectable games database
- ⭐ **Favorites** - Mark your most-used games for quick access
- 🔄 **Auto-Updates (WIP)** - Planned feature, not yet fully implemented
- 🌐 **Multi-language** - Available in English and Spanish

## 📥 Download

Download the latest version from the [GitHub Releases](https://github.com/holasoyender/disactivity/releases/latest) page.


## 🚀 How It Works

1. **Launch Disactivity** - Open the application
2. **Browse Games** - Scroll through the list or use the search bar to find a specific game
3. **Start Playing** - Click the "Run" button on any game card
4. **Discord Detection** - Discord will automatically detect and display the game activity on your profile
5. **Stop Anytime** - Click "Stop" to end the simulated activity

### Technical Details

Disactivity works by:
1. Fetching the list of detectable games from Discord's API
2. When you select a game, it creates a temporary executable with the same name as the game's actual executable
3. Discord's game detection scans for running processes with known executable names
4. Discord recognizes the process and displays the game activity on your profile
5. When stopped, the temporary files are automatically cleaned up

## 🔧 Building from Source

### Prerequisites

- [Bun](https://bun.sh/)
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)

### Build Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/holasoyender/disactivity.git
   cd disactivity
   ```

2. **Install dependencies**
   ```bash
   bun install
   ```

3. **Build the slave executable** (required)
   This component is responsible for creating the fake game process that Discord detects.
   The main app depends on it, so it must be built first.
   ```bash
   cd src-tauri/slave
   cargo build --release
   cd ../..
   ```

4. **Run in development mode**
   ```bash
   bun run tauri dev
   ```

5. **Build for production**
   ```bash
   bun run tauri build
   ```

The built application will be available in `src-tauri/target/release/bundle/`.

## 📁 Project Structure

```
disactivity/
├── src/                    # Frontend (React + TypeScript)
│   ├── components/         # UI Components
│   ├── i18n/              # Internationalization
│   │   └── locales/       # Translation files
│   └── lib/               # Utilities
├── src-tauri/             # Backend (Rust + Tauri)
│   ├── src/               # Rust source code
│   ├── slave/             # Slave executable (the fake game process)
│   └── icons/             # Application icons
└── public/                # Static assets
```

## 🛡️ Privacy & Safety

- **No data collection** - Disactivity does not collect or send any personal data
- **Open source** - All code is publicly available for review
- **Local only** - The only network requests are to Discord's public API to fetch the games list

## ⚠️ Disclaimer

This application is for entertainment purposes only. Use responsibly and in accordance with Discord's Terms of Service.

## 🧩 Troubleshooting

### App not detecting games
- Make sure Discord is running
- Restart Discord after starting a process

### Build fails
- Ensure Rust is installed and updated: `rustup update`
- Ensure Bun is properly installed

### Nothing happens when clicking "Run"
- Try running the app as administrator
- Check if antivirus is blocking the executable

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/holasoyender">holasoyender</a>
</p>

