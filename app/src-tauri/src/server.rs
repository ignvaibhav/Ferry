//! Axum HTTP + WebSocket server for the Island local API.
//!
//! Binds to `127.0.0.1:{port}` and exposes endpoints consumed by the browser
//! extension. All traffic is local-only — no external network access.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command as StdCommand;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use tauri::AppHandle;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::formats;
use crate::models::{
    DownloadRequest, DownloadResponse, FormatsRequest, FormatsResponse, HealthResponse,
    RevealRequest, StatusResponse, WsEvent,
};
use crate::queue::QueueState;

/// Application version — single source of truth.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
struct ApiState {
    queue: QueueState,
    config: AppConfig,
    app_handle: AppHandle,
    port: u16,
}

/// Start the local API server.
pub async fn run(
    queue: QueueState,
    config: AppConfig,
    app_handle: AppHandle,
    port: u16,
) -> anyhow::Result<()> {
    let state = ApiState {
        queue,
        config,
        app_handle,
        port,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/formats", post(formats_endpoint))
        .route("/download", post(download))
        .route("/reveal", post(reveal))
        .route("/open", post(open_file))
        .route("/status/:job_id", get(status))
        .route("/jobs/:job_id/cancel", post(cancel_job))
        .route("/jobs/:job_id/skip", post(skip_job))
        .route("/action/open-settings", any(open_settings_handler))
        .route("/action/open-downloads", any(open_downloads_handler))
        .route("/ws", any(ws_handler))
        .layer(middleware::from_fn(reject_web_origins))
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_methods(Any)
                .allow_origin(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    info!("Island API listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// Only the extension, Island's own webview, or non-browser clients (no Origin)
/// may call the API. Without this, any website could drive downloads or
/// open files on the user's machine through 127.0.0.1.
fn origin_allowed(origin: &str) -> bool {
    origin.starts_with("chrome-extension://")
        || origin.starts_with("moz-extension://")
        || origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
}

async fn reject_web_origins(req: Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .map(|v| v.to_str().unwrap_or("invalid"));
    if let Some(origin) = origin {
        if !origin_allowed(origin) {
            warn!(origin, "rejected request from disallowed origin");
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
    }
    next.run(req).await
}

fn is_http_url(url: &str) -> bool {
    let u = url.trim();
    u.starts_with("https://") || u.starts_with("http://")
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn health(State(state): State<ApiState>) -> Json<HealthResponse> {
    let path = state.config.effective_download_dir().await;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Downloads")
        .to_string();

    Json(HealthResponse {
        status: "ok".to_string(),
        version: VERSION.to_string(),
        port: state.port,
        download_dir_name: name,
    })
}

async fn formats_endpoint(
    State(state): State<ApiState>,
    Json(payload): Json<FormatsRequest>,
) -> Result<Json<FormatsResponse>, AppError> {
    if !is_http_url(&payload.url) {
        return Err(AppError::BadRequest("a http(s) url is required".to_string()));
    }

    match formats::fetch_formats(&payload.url).await {
        Ok(list) => {
            info!(url = %payload.url, count = list.len(), "format probe complete");
            Ok(Json(FormatsResponse { formats: list }))
        }
        Err(error) => {
            warn!(url = %payload.url, error = %error, "format probe failed");
            state.queue.publish_event(WsEvent::error(
                "system",
                format!("format lookup failed: {error}"),
            ));
            Err(AppError::BadGateway(error.to_string()))
        }
    }
}

async fn download(
    State(state): State<ApiState>,
    Json(payload): Json<DownloadRequest>,
) -> Result<Json<DownloadResponse>, AppError> {
    if !is_http_url(&payload.url) {
        return Err(AppError::BadRequest("a http(s) url is required".to_string()));
    }
    if payload.format.trim().is_empty() || payload.quality.trim().is_empty() {
        return Err(AppError::BadRequest(
            "format and quality are required".to_string(),
        ));
    }

    let job_id = Uuid::new_v4().to_string();
    info!(
        job_id = %job_id,
        shown = %payload.quality,
        sent_height = ?payload.height,
        sent_format_id = ?payload.format_id,
        "download payload queued"
    );

    state
        .queue
        .enqueue(job_id.clone(), payload)
        .await
        .map_err(|e| AppError::ServiceUnavailable(format!("queue unavailable: {e}")))?;

    Ok(Json(DownloadResponse { job_id }))
}

async fn status(
    State(state): State<ApiState>,
    Path(job_id): Path<String>,
) -> Result<Json<StatusResponse>, AppError> {
    state
        .queue
        .get_status(&job_id)
        .await
        .map(Json)
        .ok_or_else(|| AppError::NotFound("job not found".to_string()))
}

async fn cancel_job(
    State(state): State<ApiState>,
    Path(job_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    info!(job_id = %job_id, "cancel request received");
    if state.queue.cancel_job(&job_id).await {
        info!(job_id = %job_id, "cancel accepted");
        Ok(Json(serde_json::json!({ "ok": true })))
    } else {
        warn!(job_id = %job_id, "cancel rejected: job not found or not cancellable");
        Err(AppError::NotFound(
            "job not found or not cancellable".to_string(),
        ))
    }
}

async fn skip_job(
    State(state): State<ApiState>,
    Path(job_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    if state.queue.skip_job(&job_id).await {
        Ok(Json(serde_json::json!({ "ok": true })))
    } else {
        Err(AppError::NotFound(
            "job not found or not skippable".to_string(),
        ))
    }
}

async fn reveal(Json(payload): Json<RevealRequest>) -> Result<Json<serde_json::Value>, AppError> {
    let input = payload.path.trim();
    if input.is_empty() {
        return Err(AppError::BadRequest("path is required".to_string()));
    }

    let target = PathBuf::from(input);
    if !target.exists() {
        return Err(AppError::NotFound(format!(
            "path does not exist: {}",
            target.display()
        )));
    }

    crate::reveal_path(&target)
        .map(|_| Json(serde_json::json!({ "ok": true })))
        .map_err(|e| AppError::BadGateway(format!("reveal failed: {e}")))
}

async fn open_file(
    Json(payload): Json<RevealRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let input = payload.path.trim();
    if input.is_empty() {
        return Err(AppError::BadRequest("path is required".to_string()));
    }

    let target = PathBuf::from(input);
    if !target.exists() {
        return Err(AppError::NotFound(format!(
            "path does not exist: {}",
            target.display()
        )));
    }

    let result = if cfg!(target_os = "windows") {
        // explorer opens with the default app without cmd.exe re-parsing the path
        StdCommand::new("explorer").arg(&target).status().map(|_| {
            // explorer.exe returns 1 even on success
            std::process::ExitStatus::default()
        })
    } else if cfg!(target_os = "macos") {
        StdCommand::new("open").arg(&target).status()
    } else {
        StdCommand::new("xdg-open").arg(&target).status()
    };

    match result {
        Ok(exit) if exit.success() => Ok(Json(serde_json::json!({ "ok": true }))),
        Ok(exit) => Err(AppError::BadGateway(format!("open command failed: {exit}"))),
        Err(error) => Err(AppError::BadGateway(format!(
            "failed to start open command: {error}"
        ))),
    }
}

async fn open_settings_handler(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::open_settings_window(&state.app_handle).map_err(|err| {
        error!(error = %err, "failed to open settings window via API");
        AppError::Internal(format!("failed to open settings: {err}"))
    })?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn open_downloads_handler(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::open_downloads_folder(&state.config)
        .await
        .map_err(|err| {
            error!(error = %err, "failed to open downloads folder via API");
            AppError::Internal(format!("failed to open downloads: {err}"))
        })?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<ApiState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state.queue))
}

async fn handle_socket(mut socket: WebSocket, queue: QueueState) {
    let mut rx = queue.subscribe_ws();

    loop {
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            evt = rx.recv() => {
                match evt {
                    Ok(event) => {
                        if let Ok(text) = serde_json::to_string(&event) {
                            if socket.send(Message::Text(text)).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_policy() {
        assert!(origin_allowed("chrome-extension://abcdef"));
        assert!(origin_allowed("tauri://localhost"));
        assert!(origin_allowed("http://tauri.localhost"));
        assert!(!origin_allowed("https://www.youtube.com"));
        assert!(!origin_allowed("https://evil.example"));
        assert!(!origin_allowed("null"));
        assert!(is_http_url("https://youtu.be/x"));
        assert!(!is_http_url("--exec=calc"));
    }
}
