# Contributing

Thanks for wanting to help! Claude Sessions is a small, ongoing open-source project, and feedback is as useful as code.

## Ways to help

- **Answer the [2-minute questionnaire](https://sessions.aryakesarwani.tech/feedback?ref=contributing).** It shapes the roadmap, and you don't need a GitHub account.
- **Report a bug** with the [bug form](https://github.com/AryaKesharwani/claude-sessions/issues/new?template=bug_report.yml). Include `claude --version`, your terminal, and any error output. Please don't paste private session content.
- **Suggest a feature** with the [feature form](https://github.com/AryaKesharwani/claude-sessions/issues/new?template=feature_request.yml). Describe the situation first; the problem matters more than the solution.
- **Ask or share** in [Discussions](https://github.com/AryaKesharwani/claude-sessions/discussions).
- **Send a pull request.** For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Good first areas

- Linux support for the app (opening a terminal on GNOME/KDE, tiling)
- Warp, kitty, WezTerm or tmux as "Open sessions in" targets
- Searching the full conversation, not just titles and prompts
- Launch at login

## Development

```sh
# CLI: one file, no dependencies
./cs.py ls

# App
cd app
pnpm install
pnpm tauri dev          # live reload
pnpm tauri build        # release .app

# Website (sessions.aryakesarwani.tech)
cd website
npm install
npm run dev
```

The app's UI lives in `app/src` (plain HTML, CSS and JS, no framework). The Rust side, `app/src-tauri/src/main.rs`, handles menus, the tray, settings, and opening and tiling terminal windows. Listing and summaries go through the bundled `cs.py`, so the CLI and the app always agree.

## Guidelines

- Keep the UI minimal. New options belong in Settings, not the main window.
- Never write to Claude Code's session files. Reading them is fine.
- Nothing leaves the user's machine unless they explicitly ask for it (like `cs summary`).
- Match the surrounding code style. No new dependencies without a good reason.

By contributing you agree that your work is released under the [MIT licence](LICENSE).
