// Claude Sessions — a desktop front end for `cs` (../../cs.py).
// Listing and summaries are delegated to cs.py so the CLI and the app share one
// index; opening and tiling terminal windows is done with AppleScript.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const TRAY_ID: &str = "tray";

// ---------- settings ----------

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Settings {
    // general
    terminal: String,      // "terminal" | "iterm" | "ghostty"
    tile_after_open: bool, // arrange all terminal windows after opening one
    claude_args: String,   // extra args for `claude --resume`
    keep_in_menu_bar: bool,
    // menu bar
    show_tray: bool,
    tray_count: usize,
    // appearance
    theme: String,
    accent: String, // "" = theme default
    text_size: String,
    density: String,
    // list
    description: String, // "latest" | "first" | "summary"
    show_time: bool,
    show_archived: bool,
    max_age_days: u32, // 0 = everything
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            terminal: "terminal".into(),
            tile_after_open: false,
            claude_args: String::new(),
            keep_in_menu_bar: true,
            show_tray: true,
            tray_count: 10,
            theme: "system".into(),
            accent: String::new(),
            text_size: "medium".into(),
            density: "comfortable".into(),
            description: "latest".into(),
            show_time: true,
            show_archived: true,
            max_age_days: 0,
        }
    }
}

struct AppState {
    settings: Mutex<Settings>,
    tray: Mutex<Option<TrayIcon>>,
}

fn settings_file() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude-sessions/settings.json")
}

fn load_settings() -> Settings {
    std::fs::read_to_string(settings_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn settings(app: &AppHandle) -> Settings {
    app.state::<AppState>().settings.lock().unwrap().clone()
}

// ---------- process helpers ----------

/// GUI apps start with a bare PATH; borrow the user's login shell PATH once so
/// `claude` (nvm, ~/.local/bin, Homebrew) can be found.
fn user_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        Command::new(shell)
            .args(["-ilc", "printf '__PATH__%s__END__' \"$PATH\""])
            .output()
            .ok()
            .and_then(|o| {
                let out = String::from_utf8_lossy(&o.stdout).into_owned();
                let start = out.rfind("__PATH__")? + 8;
                let end = out[start..].find("__END__")? + start;
                Some(out[start..end].to_string())
            })
            .unwrap_or_else(|| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".into())
    })
}

fn cs_script(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("cs.py", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("cs.py not bundled: {e}"))
}

fn run_cs(app: &AppHandle, args: &[&str]) -> Result<String, String> {
    let out = Command::new("/usr/bin/python3")
        .arg(cs_script(app)?)
        .args(args)
        .env("PATH", user_path())
        .env("NO_COLOR", "1")
        .output()
        .map_err(|e| format!("failed to run cs.py: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(err.trim().trim_start_matches("cs: ").to_string())
    }
}

fn osascript(script: &str) -> Result<String, String> {
    let out = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn as_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn list(app: &AppHandle, limit: usize) -> Result<Vec<Value>, String> {
    let out = run_cs(app, &["ls", "--json", "-n", &limit.to_string()])?;
    let mut v: Vec<Value> = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let mtime = |s: &Value| s["mtime"].as_f64().unwrap_or(0.0);
    v.sort_by(|a, b| mtime(b).total_cmp(&mtime(a)));
    Ok(v)
}

fn title(s: &Value) -> String {
    ["custom_title", "ai_title", "first_prompt"]
        .iter()
        .find_map(|k| s[*k].as_str().filter(|t| !t.is_empty()))
        .unwrap_or("Untitled session")
        .to_string()
}

// ---------- terminals ----------

fn installed(terminal: &str) -> bool {
    match terminal {
        "iterm" => Path::new("/Applications/iTerm.app").exists(),
        "ghostty" => Path::new("/Applications/Ghostty.app").exists(),
        _ => true,
    }
}

/// Open a new terminal window that resumes the session in its original folder.
/// `cs r` restores archived sessions first, then execs `claude --resume <id>`.
fn open_one(app: &AppHandle, cfg: &Settings, id: &str, name: &str) -> Result<(), String> {
    let script = cs_script(app)?;
    let mut cmd = format!(
        "/usr/bin/python3 {} r {}",
        sh_quote(&script.to_string_lossy()),
        sh_quote(id)
    );
    if !cfg.claude_args.trim().is_empty() {
        cmd += &format!(" --claude-args {}", sh_quote(cfg.claude_args.trim()));
    }
    match cfg.terminal.as_str() {
        "iterm" if installed("iterm") => osascript(&format!(
            "tell application \"iTerm\"\n\
               set w to (create window with default profile)\n\
               tell current session of w\n\
                 set name to {}\n\
                 write text {}\n\
               end tell\n\
               activate\n\
             end tell",
            as_quote(name),
            as_quote(&format!("clear; {cmd}"))
        ))
        .map(|_| ()),
        "ghostty" if installed("ghostty") => Command::new("/usr/bin/open")
            .args(["-na", "Ghostty", "--args", &format!("--title={name}"), "-e", "/bin/zsh", "-ilc", &cmd])
            .status()
            .map_err(|e| e.to_string())
            .and_then(|s| if s.success() { Ok(()) } else { Err("could not launch Ghostty".into()) }),
        _ => osascript(&format!(
            "tell application \"Terminal\"\n\
               set t to do script {}\n\
               set custom title of t to {}\n\
               activate\n\
             end tell",
            as_quote(&format!("clear; {cmd}")),
            as_quote(name)
        ))
        .map(|_| ()),
    }
}

fn open_and_maybe_tile(app: &AppHandle, sessions: &[(String, String)]) -> Result<(), String> {
    let cfg = settings(app);
    for (id, name) in sessions {
        open_one(app, &cfg, id, name)?;
    }
    if cfg.tile_after_open || sessions.len() > 1 {
        std::thread::sleep(Duration::from_millis(600));
        tile_terminals(app, &cfg)?;
    }
    Ok(())
}

/// Usable area of the main monitor in points: (x, y, w, h), minus menu bar and Dock.
fn screen_rect(app: &AppHandle) -> (i32, i32, i32, i32) {
    let mon = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten().or_else(|| w.primary_monitor().ok().flatten()))
        .or_else(|| app.primary_monitor().ok().flatten());
    match mon {
        Some(m) => {
            let scale = m.scale_factor();
            let area = m.work_area();
            let pos = area.position.to_logical::<f64>(scale);
            let size = area.size.to_logical::<f64>(scale);
            (pos.x as i32, pos.y as i32, size.width as i32, size.height as i32)
        }
        None => (0, 38, 1440, 860),
    }
}

/// Arrange every visible window of the chosen terminal in a grid.
fn tile_terminals(app: &AppHandle, cfg: &Settings) -> Result<usize, String> {
    let (target, windows) = match cfg.terminal.as_str() {
        "iterm" if installed("iterm") => ("iTerm", "windows"),
        "ghostty" => return Err("Tiling isn't supported for Ghostty yet".into()),
        _ => ("Terminal", "(windows whose visible is true)"),
    };
    let (x, y, w, h) = screen_rect(app);
    let n: i32 = osascript(&format!("tell application \"{target}\" to count {windows}"))?
        .parse()
        .unwrap_or(0);
    if n == 0 {
        return Ok(0);
    }
    let cols = (n as f64).sqrt().ceil() as i32;
    let rows = (n + cols - 1) / cols;
    let rh = h / rows;
    let mut lines = format!("tell application \"{target}\"\nset ws to {windows}\n");
    for i in 0..n {
        let (c, r) = (i % cols, i / cols);
        // The last row stretches its windows to fill the full width.
        let in_row = if r == rows - 1 { n - r * cols } else { cols };
        let cw = w / in_row;
        let (left, top) = (x + c * cw, y + r * rh);
        lines += &format!(
            "set bounds of item {} of ws to {{{}, {}, {}, {}}}\n",
            i + 1,
            left,
            top,
            left + cw,
            top + rh
        );
    }
    lines += "activate\nend tell";
    osascript(&lines)?;
    Ok(n as usize)
}

// ---------- windows ----------

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn open_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Settings")
        .inner_size(620.0, 680.0)
        .min_inner_size(520.0, 420.0)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .build();
}

// ---------- menus ----------

fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    // Insert "Settings…  ⌘," into the app (first) submenu, after "About".
    if let Some(app_menu) = menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
        let item = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
        app_menu.insert(&item, 1)?;
        app_menu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
    }
    Ok(menu)
}

fn clip(s: &str, n: usize) -> String {
    let s: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n {
        s
    } else {
        s.chars().take(n - 1).collect::<String>() + "…"
    }
}

fn build_tray_menu(app: &AppHandle, cfg: &Settings) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "hdr", "Recent sessions", false, None::<&str>)?)?;
    match list(app, cfg.tray_count.max(1)) {
        Ok(sessions) if !sessions.is_empty() => {
            for s in &sessions {
                let id = s["id"].as_str().unwrap_or_default();
                menu.append(&MenuItem::with_id(app, format!("open:{id}"), clip(&title(s), 48), true, None::<&str>)?)?;
            }
        }
        Ok(_) => menu.append(&MenuItem::with_id(app, "none", "No sessions yet", false, None::<&str>)?)?,
        Err(e) => menu.append(&MenuItem::with_id(app, "err", clip(&e, 48), false, None::<&str>)?)?,
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "show", "Show All Sessions", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "tile", "Tile Terminal Windows", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Claude Sessions", true, Some("CmdOrCtrl+Q"))?)?;
    Ok(menu)
}

/// Create, refresh, show or hide the menu bar icon to match the settings.
fn sync_tray(app: &AppHandle) {
    let cfg = settings(app);
    let state = app.state::<AppState>();
    let mut slot = state.tray.lock().unwrap();
    if !cfg.show_tray {
        if let Some(t) = slot.as_ref() {
            let _ = t.set_visible(false);
        }
        return;
    }
    let menu = match build_tray_menu(app, &cfg) {
        Ok(m) => m,
        Err(_) => return,
    };
    if let Some(t) = slot.as_ref() {
        let _ = t.set_menu(Some(menu));
        let _ = t.set_visible(true);
        return;
    }
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png")).expect("tray icon");
    *slot = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Claude Sessions")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)
        .ok();
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "settings" => open_settings_window(app),
        "show" => show_main(app),
        "quit" => app.exit(0),
        "tile" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = tile_terminals(&app, &settings(&app)) {
                    let _ = app.emit("notice", e);
                }
            });
        }
        _ => {
            if let Some(sid) = id.strip_prefix("open:") {
                let (app, sid) = (app.clone(), sid.to_string());
                std::thread::spawn(move || {
                    let name = list(&app, 100000)
                        .ok()
                        .and_then(|v| v.into_iter().find(|s| s["id"] == sid.as_str()))
                        .map(|s| title(&s))
                        .unwrap_or_else(|| "Claude".into());
                    if let Err(e) = open_and_maybe_tile(&app, &[(sid, name)]) {
                        let _ = app.emit("notice", e);
                    }
                });
            }
        }
    }
}

// ---------- commands ----------

#[tauri::command]
async fn list_sessions(app: AppHandle) -> Result<Vec<Value>, String> {
    blocking(move || list(&app, 100000)).await
}

#[tauri::command]
async fn summarize(app: AppHandle, id: String) -> Result<String, String> {
    blocking(move || run_cs(&app, &["summary", &id])).await
}

#[tauri::command]
async fn open_sessions(app: AppHandle, sessions: Vec<(String, String)>) -> Result<(), String> {
    blocking(move || open_and_maybe_tile(&app, &sessions)).await
}

#[tauri::command]
async fn tile_all(app: AppHandle) -> Result<usize, String> {
    blocking(move || tile_terminals(&app, &settings(&app))).await
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    settings(&app)
}

#[tauri::command]
fn installed_terminals() -> Vec<String> {
    ["terminal", "iterm", "ghostty"]
        .into_iter()
        .filter(|t| installed(t))
        .map(String::from)
        .collect()
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_file();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    *app.state::<AppState>().settings.lock().unwrap() = settings.clone();
    app.emit("settings-changed", settings).map_err(|e| e.to_string())?;
    let handle = app.clone();
    std::thread::spawn(move || sync_tray(&handle));
    Ok(())
}

#[tauri::command]
fn reset_settings(app: AppHandle) -> Result<Settings, String> {
    save_settings(app, Settings::default())?;
    Ok(Settings::default())
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    open_settings_window(&app);
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            settings: Mutex::new(load_settings()),
            tray: Mutex::new(None),
        })
        .menu(|app| build_app_menu(app))
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .setup(|app| {
            let handle = app.handle().clone();
            // Build the tray, then keep its "recent sessions" fresh.
            std::thread::spawn(move || loop {
                sync_tray(&handle);
                std::thread::sleep(Duration::from_secs(30));
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let cfg = settings(window.app_handle());
                if window.label() == "main" && cfg.keep_in_menu_bar && cfg.show_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            summarize,
            open_sessions,
            tile_all,
            get_settings,
            save_settings,
            reset_settings,
            installed_terminals,
            open_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building Claude Sessions")
        .run(|app, event| {
            // Clicking the Dock icon brings the hidden window back.
            if let RunEvent::Reopen { .. } = event {
                show_main(app);
            }
        });
}
