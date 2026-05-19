#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Island desktop companion — system tray app with local API server.
//!
//! Runs silently in the system tray, exposing a local HTTP/WebSocket API
//! that the browser extension uses to queue and monitor downloads.

mod config;
mod downloader;
mod error;
mod formats;
mod models;
mod queue;
mod server;

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::menu::{AboutMetadataBuilder, Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tracing::{error, info};

use crate::config::AppConfig;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SETTINGS_FILE_NAME: &str = "settings.json";
const API_PORT: u16 = 49152;
const MENU_SETTINGS_ID: &str = "settings";
const MENU_OPEN_DOWNLOADS_ID: &str = "open_downloads";
const MENU_QUIT_ID: &str = "quit";

// ---------------------------------------------------------------------------
// Persisted settings
// ---------------------------------------------------------------------------

/// Settings persisted to disk in the app config directory.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AppSettings {
    download_dir: Option<String>,
}

/// Response shape for settings-related Tauri commands.
#[derive(Debug, Clone, Serialize)]
struct DownloadSettingsResponse {
    current_download_dir: String,
    default_download_dir: String,
}

#[derive(Debug, Clone, Serialize)]
struct ReleaseDownloadResponse {
    version: String,
    downloaded_path: String,
    extracted_app_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Settings file I/O
// ---------------------------------------------------------------------------

fn settings_path(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(SETTINGS_FILE_NAME))
}

fn load_settings(app: &AppHandle) -> anyhow::Result<AppSettings> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = fs::read_to_string(path)?;
    let parsed = serde_json::from_str::<AppSettings>(&content)?;
    Ok(parsed)
}

fn save_settings(app: &AppHandle, settings: &AppSettings) -> anyhow::Result<()> {
    let path = settings_path(app)?;
    let data = serde_json::to_string_pretty(settings)?;
    fs::write(path, data)?;
    Ok(())
}

fn sanitize_version_tag(version: &str) -> String {
    let cleaned = version.trim().trim_start_matches('v');
    let sanitized: String = cleaned
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => ch,
            _ => '-',
        })
        .collect();

    if sanitized.is_empty() {
        "latest".to_string()
    } else {
        sanitized
    }
}

fn updates_download_dir() -> PathBuf {
    config::default_download_dir().join("Island Updates")
}

fn reveal_path(target: &Path) -> anyhow::Result<()> {
    if cfg!(target_os = "windows") {
        let selector = format!("/select,{}", target.display());
        std::process::Command::new("explorer")
            .arg(selector)
            .status()?;
        return Ok(());
    }

    if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg("-R")
            .arg(target)
            .status()?;
        return Ok(());
    }

    let dir = if target.is_file() {
        target.parent().unwrap_or(target)
    } else {
        target
    };
    std::process::Command::new("xdg-open").arg(dir).status()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings window
// ---------------------------------------------------------------------------

pub fn open_settings_window(app: &AppHandle) -> anyhow::Result<()> {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Island Settings")
        .inner_size(690.0, 420.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .visible(true)
        .build()?;

    let _ = win.set_focus();
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_download_settings(app: AppHandle) -> Result<DownloadSettingsResponse, String> {
    let settings = load_settings(&app).map_err(|e| e.to_string())?;
    let default_download_dir = config::default_download_dir().display().to_string();
    let current_download_dir = settings
        .download_dir
        .unwrap_or_else(|| default_download_dir.clone());
    Ok(DownloadSettingsResponse {
        current_download_dir,
        default_download_dir,
    })
}

#[tauri::command]
async fn set_download_directory(
    app: AppHandle,
    state: tauri::State<'_, AppConfig>,
    path: String,
) -> Result<DownloadSettingsResponse, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Download path cannot be empty".to_string());
    }

    let target = PathBuf::from(trimmed);
    fs::create_dir_all(&target).map_err(|e| format!("Failed to create download path: {e}"))?;
    let normalized = target
        .canonicalize()
        .unwrap_or_else(|_| target.clone())
        .display()
        .to_string();

    // Persist to disk
    let mut settings = load_settings(&app).map_err(|e| e.to_string())?;
    settings.download_dir = Some(normalized.clone());
    save_settings(&app, &settings).map_err(|e| e.to_string())?;

    // Update runtime config
    state.set_download_dir(Some(normalized.clone())).await;
    info!(path = %normalized, "download directory updated");

    let default_download_dir = config::default_download_dir().display().to_string();

    Ok(DownloadSettingsResponse {
        current_download_dir: normalized,
        default_download_dir,
    })
}

#[tauri::command]
async fn reset_download_directory(
    app: AppHandle,
    state: tauri::State<'_, AppConfig>,
) -> Result<DownloadSettingsResponse, String> {
    let mut settings = load_settings(&app).map_err(|e| e.to_string())?;
    settings.download_dir = None;
    save_settings(&app, &settings).map_err(|e| e.to_string())?;

    state.set_download_dir(None).await;
    info!("download directory reset to default");

    let default_download_dir = config::default_download_dir().display().to_string();
    Ok(DownloadSettingsResponse {
        current_download_dir: default_download_dir.clone(),
        default_download_dir,
    })
}

#[tauri::command]
fn browse_download_directory(current_path: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(path) = current_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            dialog = dialog.set_directory(trimmed);
        }
    }
    let selected = dialog.pick_folder().map(|p| p.display().to_string());
    Ok(selected)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http and https links are supported".to_string());
    }

    if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open link: {e}"))?;
        return Ok(());
    }

    if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open link: {e}"))?;
        return Ok(());
    }

    std::process::Command::new("xdg-open")
        .arg(trimmed)
        .spawn()
        .map_err(|e| format!("Failed to open link: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn download_release_asset(
    version: String,
    asset_name: String,
    asset_url: String,
) -> Result<ReleaseDownloadResponse, String> {
    let version = sanitize_version_tag(&version);
    let asset_name = asset_name.trim().to_string();
    let asset_url = asset_url.trim().to_string();

    if asset_name.is_empty() {
        return Err("Missing release asset name".to_string());
    }

    if !asset_url.starts_with("https://github.com/") {
        return Err("Unsupported release asset URL".to_string());
    }

    let destination_dir = updates_download_dir().join(format!("v{version}"));
    fs::create_dir_all(&destination_dir)
        .map_err(|e| format!("Failed to create update folder: {e}"))?;

    let archive_path = destination_dir.join(&asset_name);
    let download_status = if cfg!(target_os = "windows") {
        std::process::Command::new("curl")
            .arg("-L")
            .arg(&asset_url)
            .arg("-o")
            .arg(&archive_path)
            .status()
            .map_err(|e| format!("Failed to start update download: {e}"))?
    } else {
        std::process::Command::new("curl")
            .arg("-L")
            .arg(&asset_url)
            .arg("-o")
            .arg(&archive_path)
            .status()
            .map_err(|e| format!("Failed to start update download: {e}"))?
    };

    if !download_status.success() {
        return Err("Release download failed".to_string());
    }

    let mut extracted_app_path = None;

    if cfg!(target_os = "macos") && asset_name.ends_with(".zip") {
        let extracted_dir = destination_dir.join("macOS");
        if extracted_dir.exists() {
            fs::remove_dir_all(&extracted_dir)
                .map_err(|e| format!("Failed to refresh extracted update folder: {e}"))?;
        }
        fs::create_dir_all(&extracted_dir)
            .map_err(|e| format!("Failed to prepare extracted update folder: {e}"))?;

        let unzip_status = std::process::Command::new("ditto")
            .arg("-x")
            .arg("-k")
            .arg(&archive_path)
            .arg(&extracted_dir)
            .status()
            .map_err(|e| format!("Failed to unpack update: {e}"))?;

        if !unzip_status.success() {
            return Err("Update archive could not be unpacked".to_string());
        }

        let app_path = extracted_dir.join("Island.app");
        if app_path.exists() {
            reveal_path(&app_path)
                .map_err(|e| format!("Failed to reveal update in Finder: {e}"))?;
            extracted_app_path = Some(app_path.display().to_string());
        } else {
            reveal_path(&archive_path)
                .map_err(|e| format!("Failed to reveal downloaded archive: {e}"))?;
        }
    } else {
        reveal_path(&archive_path).map_err(|e| format!("Failed to reveal update download: {e}"))?;
    }

    Ok(ReleaseDownloadResponse {
        version,
        downloaded_path: archive_path.display().to_string(),
        extracted_app_path,
    })
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

pub async fn open_downloads_folder(config: &AppConfig) -> anyhow::Result<()> {
    let path = config.effective_download_dir().await;

    if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&path).spawn()?;
        return Ok(());
    }

    if cfg!(target_os = "windows") {
        std::process::Command::new("explorer").arg(&path).spawn()?;
        return Ok(());
    }

    std::process::Command::new("xdg-open").arg(&path).spawn()?;
    Ok(())
}

fn handle_menu_action(app: &AppHandle, config: &AppConfig, event_id: &str) {
    match event_id {
        MENU_SETTINGS_ID => {
            if let Err(err) = open_settings_window(app) {
                error!(error = %err, "failed to open settings window");
            }
        }
        MENU_OPEN_DOWNLOADS_ID => {
            let cfg = config.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = open_downloads_folder(&cfg).await {
                    error!(error = %err, "failed to open downloads folder");
                }
            });
        }
        MENU_QUIT_ID => {
            info!("user quit from application menu");
            app.exit(0);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    // Initialize structured logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .compact()
        .init();

    info!(version = server::VERSION, "starting Island desktop");

    // Create shared config
    let app_config = AppConfig::new(None);

    // Start download queue
    let (queue_state, receiver) = queue::QueueState::new(128);
    let worker_queue = queue_state.clone();
    let worker_config = app_config.clone();
    tauri::async_runtime::spawn(queue::run_worker(worker_queue, worker_config, receiver));

    let mut builder = tauri::Builder::default()
        .manage(app_config.clone())
        .invoke_handler(tauri::generate_handler![
            get_download_settings,
            set_download_directory,
            reset_download_directory,
            browse_download_directory,
            open_external_url,
            download_release_asset
        ])
        .plugin({
            // MacosLauncher::LaunchAgent is a macOS-only concept; on other platforms
            // the autostart plugin accepts a plain unit type — guard it here so the
            // binary compiles on Windows and Linux without changes.
            #[cfg(target_os = "macos")]
            {
                tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    Some(vec!["--hidden"]),
                )
            }
            #[cfg(not(target_os = "macos"))]
            {
                tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    None,
                )
            }
        });

    #[cfg(target_os = "macos")]
    {
        let menu_config = app_config.clone();
        builder = builder
            .menu(|app| {
                let app_menu = SubmenuBuilder::new(app, "Island")
                    .about(Some(
                        AboutMetadataBuilder::new()
                            .name(Some("Island"))
                            .version(Some(server::VERSION))
                            .build(),
                    ))
                    .separator()
                    .text(MENU_SETTINGS_ID, "Settings…")
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .separator()
                    .quit_with_text("Quit Island")
                    .build()?;

                let file_menu = SubmenuBuilder::new(app, "File")
                    .text(MENU_OPEN_DOWNLOADS_ID, "Open Downloads Folder")
                    .separator()
                    .close_window()
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;

                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .separator()
                    .close_window()
                    .build()?;

                let help_menu = SubmenuBuilder::new(app, "Help")
                    .about_with_text("About Island", None)
                    .build()?;

                MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&file_menu)
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&window_menu)
                    .item(&help_menu)
                    .build()
            })
            .on_menu_event(move |app, event| {
                handle_menu_action(app, &menu_config, event.id().as_ref());
            })
            .on_tray_icon_event(|app, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    if let Err(err) = open_settings_window(app) {
                        error!(error = %err, "failed to open settings window from tray click");
                    }
                }
            });
    }

    builder
        .setup(move |app| {
            // Start API server
            let api_queue = queue_state.clone();
            let api_config = app_config.clone();
            let api_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = server::run(api_queue, api_config, api_handle, API_PORT).await {
                    error!(error = %err, "Island API server crashed");
                }
            });

            // Load persisted settings into runtime config
            if let Ok(settings) = load_settings(app.handle()) {
                if let Some(dir) = &settings.download_dir {
                    let config = app_config.clone();
                    let dir = dir.clone();
                    tauri::async_runtime::spawn(async move {
                        config.set_download_dir(Some(dir)).await;
                    });
                    info!(
                        download_dir = settings.download_dir.as_deref().unwrap_or("(default)"),
                        "loaded persisted settings"
                    );
                }
            }

            // Build system tray
            let settings_item =
                MenuItem::with_id(app, MENU_SETTINGS_ID, "Settings", true, None::<&str>)?;
            let open_downloads = MenuItem::with_id(
                app,
                MENU_OPEN_DOWNLOADS_ID,
                "Open Downloads Folder",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, MENU_QUIT_ID, "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &open_downloads, &quit])?;

            let _ = TrayIconBuilder::with_id("island").menu(&menu).build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Island Tauri app");
}
