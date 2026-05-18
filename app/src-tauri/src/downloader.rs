//! yt-dlp download execution and progress parsing.
//!
//! Resolves bundled sidecar binaries, constructs the command with the
//! appropriate flags, and streams progress events back to the caller via an
//! [`mpsc::Sender`].

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use regex::Regex;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::lookup_host;
use tokio::process::Command;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::config::AppConfig;
use crate::models::DownloadRequest;

/// Maximum time allowed for a single download subprocess.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60); // 30 minutes

/// YouTube extractor arguments for broader client coverage.
const EXTRACTOR_ARGS: &str = "youtube:player_client=android_vr,web_safari,android,web";

// Pre-compiled regex patterns — built once, reused for every download.
static PROGRESS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[download\]\s+(\d{1,3}(?:\.\d+)?)%").unwrap());
static SPEED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bat\s+([^\s]+)").unwrap());
static ETA_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bETA\s+([^\s]+)").unwrap());

/// Events emitted during a download for progress tracking.
#[derive(Debug, Clone)]
pub enum DownloadEvent {
    Progress {
        percent: u8,
        speed: Option<String>,
        eta: Option<String>,
    },
    Done {
        path: String,
    },
    Error {
        message: String,
    },
}

/// Execute a download job, streaming progress events through `tx`.
///
/// Uses only the bundled sidecar binaries packaged with Island.
pub async fn run_download(
    job_id: &str,
    request: &DownloadRequest,
    tx: mpsc::Sender<DownloadEvent>,
    config: AppConfig,
    cancel_flag: Arc<AtomicBool>,
) -> Result<()> {
    let yt_dlp = resolve_binary("yt-dlp")?;
    let ffmpeg_location = if download_requires_ffmpeg(request) {
        Some(resolve_ffmpeg_location()?)
    } else {
        None
    };
    let output_template = build_output_template(request, &config).await;

    info!(
        job_id,
        shown = %request.quality,
        sent_height = ?request.height,
        sent_format_id = ?request.format_id,
        "download request received"
    );

    preflight_connectivity_check(request, &tx).await?;

    let mut cmd = build_download_command(
        &yt_dlp,
        ffmpeg_location.as_deref(),
        request,
        &output_template,
    );
    let result = tokio::time::timeout(
        DOWNLOAD_TIMEOUT,
        execute_download(job_id, &mut cmd, &tx, cancel_flag.clone()),
    )
    .await;

    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(err),
        Err(_timeout) => {
            let message = humanize_download_error(&format!(
                "download timed out after {} minutes",
                DOWNLOAD_TIMEOUT.as_secs() / 60
            ));
            let _ = tx
                .send(DownloadEvent::Error {
                    message: message.clone(),
                })
                .await;
            Err(anyhow!(message))
        }
    }
}

/// Run a single yt-dlp subprocess, parsing stdout/stderr.
async fn execute_download(
    job_id: &str,
    cmd: &mut Command,
    tx: &mpsc::Sender<DownloadEvent>,
    cancel_flag: Arc<AtomicBool>,
) -> Result<()> {
    let mut child = cmd.spawn().context("failed to spawn yt-dlp")?;
    let child_pid = child.id();
    let stdout = child.stdout.take().context("missing stdout from yt-dlp")?;
    let stderr = child.stderr.take().context("missing stderr from yt-dlp")?;

    let tx_out = tx.clone();
    let job_id_out = job_id.to_string();
    let job_id_err = job_id.to_string();

    let out_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut final_path: Option<String> = None;

        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(caps) = PROGRESS_RE.captures(&line) {
                let percent = caps
                    .get(1)
                    .and_then(|m| m.as_str().split('.').next())
                    .and_then(|v| v.parse::<u8>().ok())
                    .unwrap_or(0)
                    .min(100);

                let speed = SPEED_RE
                    .captures(&line)
                    .and_then(|m| m.get(1))
                    .map(|m| m.as_str().to_string());
                let eta = ETA_RE
                    .captures(&line)
                    .and_then(|m| m.get(1))
                    .map(|m| m.as_str().to_string());

                info!(
                    job_id = %job_id_out,
                    percent,
                    speed = ?speed,
                    eta = ?eta,
                    "yt-dlp progress"
                );

                let _ = tx_out
                    .send(DownloadEvent::Progress {
                        percent,
                        speed,
                        eta,
                    })
                    .await;
                continue;
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            info!(job_id = %job_id_out, line = %trimmed, "yt-dlp stdout");

            if trimmed.starts_with("[download]") && trimmed.ends_with("has already been downloaded")
            {
                let entry = trimmed
                    .trim_start_matches("[download]")
                    .trim()
                    .trim_end_matches("has already been downloaded")
                    .trim();
                if !entry.is_empty() {
                    final_path = Some(entry.to_string());
                }
                continue;
            }

            if !trimmed.starts_with('[') {
                final_path = Some(trimmed.to_string());
            }
        }

        (job_id_out, final_path)
    });

    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut last_error: Option<String> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            warn!(job_id = %job_id_err, line = %trimmed, "yt-dlp stderr");
            if trimmed.starts_with("ERROR:") {
                last_error = Some(trimmed.to_string());
            }
        }
        (job_id_err, last_error)
    });

    let status = loop {
        if cancel_flag.load(Ordering::SeqCst) {
            if let Some(pid) = child_pid {
                terminate_process(pid).await;
            } else {
                let _ = child.kill().await;
            }
            let message = "Cancelled by user".to_string();
            let _ = tx
                .send(DownloadEvent::Error {
                    message: message.clone(),
                })
                .await;
            return Err(anyhow!(message));
        }

        match child.try_wait().context("yt-dlp process failed")? {
            Some(status) => break status,
            None => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    };

    let (_, final_path) = out_task.await.context("stdout task join error")?;
    let (_, last_error) = err_task.await.context("stderr task join error")?;

    if !status.success() {
        let message = if cancel_flag.load(Ordering::SeqCst) {
            "Cancelled by user".to_string()
        } else {
            humanize_download_error(
                &last_error.unwrap_or_else(|| format!("download failed for job {job_id}")),
            )
        };
        return Err(anyhow!(message));
    }

    let _ = tx
        .send(DownloadEvent::Progress {
            percent: 100,
            speed: None,
            eta: None,
        })
        .await;

    let done_path =
        final_path.unwrap_or_else(|| crate::config::default_download_dir().display().to_string());
    let _ = tx.send(DownloadEvent::Done { path: done_path }).await;
    Ok(())
}

/// Build the yt-dlp command with all necessary flags.
fn build_download_command(
    binary: &Path,
    ffmpeg_location: Option<&Path>,
    request: &DownloadRequest,
    output_template: &str,
) -> Command {
    let mut cmd = Command::new(binary);
    cmd.arg("--newline")
        .arg("--no-warnings")
        .arg("--no-overwrites")
        .arg("--no-post-overwrites")
        .arg("--force-ipv4")
        .arg("--retries")
        .arg("10")
        .arg("--fragment-retries")
        .arg("10")
        .arg("--extractor-retries")
        .arg("3")
        .arg("--file-access-retries")
        .arg("3")
        .arg("--extractor-args")
        .arg(EXTRACTOR_ARGS);

    if let Some(location) = ffmpeg_location {
        cmd.arg("--ffmpeg-location").arg(location);
    }

    cmd.arg("-o")
        .arg(output_template)
        .arg("--print")
        .arg("after_move:filepath");

    apply_format_flags(request, &mut cmd);

    info!(
        binary = %binary.display(),
        shown = %request.quality,
        chosen_height = ?request.height,
        chosen_format_id = ?request.format_id,
        "yt-dlp command selected"
    );

    if let Some(clip) = &request.clip {
        if !is_thumbnail_request(request) {
            cmd.arg("--download-sections")
                .arg(format!("*{}-{}", clip.start, clip.end))
                .arg("--force-keyframes-at-cuts");
        }
    }

    let source_url = request_source_url(request);
    cmd.arg(&source_url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

/// Apply format selection flags based on the download request.
fn apply_format_flags(request: &DownloadRequest, cmd: &mut Command) {
    if is_thumbnail_request(request) {
        if selected_thumbnail_url(request).is_some() {
            info!(shown = %request.quality, "using direct thumbnail url selector");
            return;
        }
        info!(shown = %request.quality, "using thumbnail selector");
        cmd.arg("--skip-download")
            .arg("--write-thumbnail")
            .arg("--convert-thumbnails")
            .arg("jpg");
        return;
    }

    if is_audio_request(request) {
        if let Some(target_abr) = requested_audio_kbps(request) {
            let selector = format!("bestaudio[abr<={target_abr}]/bestaudio/best");
            info!(shown = %request.quality, selector = %selector, "using audio bitrate selector");
            cmd.arg("-f").arg(selector);
        } else {
            info!(shown = %request.quality, "using best audio selector");
            cmd.arg("-f").arg("bestaudio/best");
        }
        cmd.arg("--extract-audio").arg("--audio-format").arg("mp3");
        return;
    }

    if let Some(format_id) = &request.format_id {
        if !format_id.trim().is_empty() {
            info!(
                shown = %request.quality,
                chosen_format_id = %format_id,
                "using explicit selector"
            );
            cmd.arg("-f").arg(format_id);
            apply_mp4_output_flags(cmd);
            return;
        }
    }

    let height = request
        .height
        .map(|value| value.to_string())
        .unwrap_or_else(|| {
            request
                .quality
                .chars()
                .filter(char::is_ascii_digit)
                .collect::<String>()
        });

    if height.is_empty() {
        info!(shown = %request.quality, "using broad fallback selector");
        cmd.arg("-f").arg("bestvideo*+bestaudio/best");
        apply_mp4_output_flags(cmd);
        return;
    }

    info!(
        shown = %request.quality,
        chosen_height = %height,
        "using height ceiling selector"
    );
    cmd.arg("-f").arg(format!(
        "bestvideo[height<={height}]+bestaudio/best[height<={height}]/best"
    ));
    apply_mp4_output_flags(cmd);
}

fn apply_mp4_output_flags(cmd: &mut Command) {
    cmd.arg("--merge-output-format")
        .arg("mp4")
        .arg("--remux-video")
        .arg("mp4");
}

fn is_audio_request(request: &DownloadRequest) -> bool {
    request
        .media_type
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("audio"))
        || request.format.eq_ignore_ascii_case("mp3")
        || request.quality.eq_ignore_ascii_case("audio")
}

fn download_requires_ffmpeg(request: &DownloadRequest) -> bool {
    !is_thumbnail_request(request)
}

fn requested_audio_kbps(request: &DownloadRequest) -> Option<u16> {
    let digits = request
        .quality
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>();

    if digits.is_empty() {
        None
    } else {
        digits.parse::<u16>().ok().filter(|value| *value > 0)
    }
}

fn is_thumbnail_request(request: &DownloadRequest) -> bool {
    request
        .media_type
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("thumbnail"))
        || request.format.eq_ignore_ascii_case("thumbnail")
        || request.quality.eq_ignore_ascii_case("thumbnail")
}

fn selected_thumbnail_url(request: &DownloadRequest) -> Option<String> {
    if !is_thumbnail_request(request) {
        return None;
    }
    let selector = request
        .format_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())?;

    crate::formats::resolve_thumbnail_selector(selector)
}

fn request_source_url(request: &DownloadRequest) -> String {
    selected_thumbnail_url(request).unwrap_or_else(|| request.url.clone())
}

async fn preflight_connectivity_check(
    request: &DownloadRequest,
    tx: &mpsc::Sender<DownloadEvent>,
) -> Result<()> {
    let source_url = request_source_url(request);
    let Some(host) = extract_host(&source_url) else {
        return Ok(());
    };

    let resolved = tokio::time::timeout(Duration::from_secs(3), lookup_host((host.as_str(), 443)))
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(|mut addrs| addrs.next());

    if resolved.is_some() {
        return Ok(());
    }

    let message = format!("No internet / DNS failed. Could not resolve {host}.");
    let _ = tx
        .send(DownloadEvent::Error {
            message: message.clone(),
        })
        .await;
    Err(anyhow!(message))
}

fn extract_host(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let authority = rest.split('/').next()?.trim();
    if authority.is_empty() {
        return None;
    }
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = authority.split(':').next()?.trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

fn humanize_download_error(message: &str) -> String {
    let trimmed = message.trim();
    let lower = trimmed.to_ascii_lowercase();

    if lower.contains("failed to resolve")
        || lower.contains("nodename nor servname provided")
        || lower.contains("name or service not known")
    {
        return "No internet / DNS failed. Could not resolve the download host.".to_string();
    }

    if lower.contains("timed out") {
        return "Download timed out. Cancel or skip the stuck job and try again.".to_string();
    }

    if lower.contains("ffprobe and ffmpeg not found")
        || lower.contains("provide the path using --ffmpeg-location")
        || lower.contains("sidecar not found in bundled resources")
    {
        return "Bundled ffmpeg/ffprobe sidecars are missing or invalid. Island can only finalize audio/video downloads when real sidecars are bundled.".to_string();
    }

    if let Some(stripped) = trimmed.strip_prefix("ERROR:") {
        return stripped.trim().to_string();
    }

    trimmed.to_string()
}

async fn terminate_process(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        if let Ok(mut child) = Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            let _ = child.wait().await;
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(mut child) = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            let _ = child.wait().await;
        }
    }
}

/// Resolve a binary by name from bundled sidecar resources only.
pub fn resolve_binary(name: &str) -> Result<PathBuf> {
    let candidates = sidecar_candidates(name);
    for candidate in candidates {
        if candidate.exists() && !is_placeholder_sidecar(&candidate) {
            info!(binary = %candidate.display(), "resolved sidecar binary");
            return Ok(candidate);
        }
    }
    Err(anyhow!("{name} sidecar not found in bundled resources"))
}

/// Check if a sidecar file is just a placeholder.
fn is_placeholder_sidecar(path: &Path) -> bool {
    if fs::metadata(path)
        .map(|meta| meta.len() == 0)
        .unwrap_or(false)
    {
        return true;
    }

    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    content
        .trim()
        .eq_ignore_ascii_case("placeholder: replace with real binary")
}

fn resolve_ffmpeg_location() -> Result<PathBuf> {
    let ffmpeg = resolve_binary("ffmpeg")?;
    let ffprobe = resolve_binary("ffprobe")?;
    let alias_dir = std::env::temp_dir().join("island-sidecars");
    fs::create_dir_all(&alias_dir)
        .with_context(|| format!("failed to create sidecar alias dir {}", alias_dir.display()))?;

    link_or_copy_sidecar(&ffmpeg, &alias_dir.join(executable_alias("ffmpeg")))?;
    link_or_copy_sidecar(&ffprobe, &alias_dir.join(executable_alias("ffprobe")))?;

    Ok(alias_dir)
}

fn executable_alias(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

#[cfg(unix)]
fn link_or_copy_sidecar(source: &Path, destination: &Path) -> Result<()> {
    use std::os::unix::fs as unix_fs;

    if fs::symlink_metadata(destination).is_ok() {
        fs::remove_file(destination).with_context(|| {
            format!("failed to replace sidecar alias {}", destination.display())
        })?;
    }

    if cfg!(target_os = "macos") {
        fs::copy(source, destination)
            .map(|_| ())
            .and_then(|_| {
                let permissions = fs::metadata(source)?.permissions();
                fs::set_permissions(destination, permissions)
            })
            .with_context(|| {
                format!(
                    "failed to prepare sidecar alias {} -> {}",
                    destination.display(),
                    source.display()
                )
            })
    } else {
        unix_fs::symlink(source, destination)
            .or_else(|_| {
                fs::copy(source, destination)
                    .map(|_| ())
                    .and_then(|_| {
                        let permissions = fs::metadata(source)?.permissions();
                        fs::set_permissions(destination, permissions)
                    })
                    .with_context(|| {
                        format!(
                            "failed to copy sidecar {} to {}",
                            source.display(),
                            destination.display()
                        )
                    })
            })
            .with_context(|| {
                format!(
                    "failed to prepare sidecar alias {} -> {}",
                    destination.display(),
                    source.display()
                )
            })
    }
}

#[cfg(windows)]
fn link_or_copy_sidecar(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        fs::remove_file(destination).with_context(|| {
            format!("failed to replace sidecar alias {}", destination.display())
        })?;
    }

    fs::copy(source, destination).map(|_| ()).with_context(|| {
        format!(
            "failed to copy sidecar {} to {}",
            source.display(),
            destination.display()
        )
    })
}

/// Generate candidate paths for a platform-specific sidecar binary.
fn sidecar_candidates(name: &str) -> Vec<PathBuf> {
    let mut names = Vec::new();
    if cfg!(target_os = "macos") {
        names.push(format!("{name}-mac"));
    } else if cfg!(target_os = "windows") {
        names.push(format!("{name}-win.exe"));
    } else {
        names.push(format!("{name}-linux"));
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if cfg!(target_os = "macos") {
                if let Some(contents_dir) = parent.parent() {
                    let bundle_resource_dir = contents_dir.join("Resources").join("resources");
                    for n in &names {
                        candidates.push(bundle_resource_dir.join(n));
                    }
                }
            }

            let resource_dir = parent.join("resources");
            for n in &names {
                candidates.push(resource_dir.join(n));
            }
        }
    }

    for n in &names {
        candidates.push(Path::new("resources").join(n));
        candidates.push(Path::new("app/src-tauri/resources").join(n));
    }

    candidates
}

/// Build the output file path template for yt-dlp.
async fn build_output_template(request: &DownloadRequest, config: &AppConfig) -> String {
    let dir = config.effective_download_dir().await;
    let safe_title =
        sanitize_title_for_filename(request.title.as_deref().unwrap_or("Island Video"));
    let quality = sanitize_name_fragment(&request.quality);
    let format_tag = request
        .format_id
        .as_deref()
        .map(sanitize_name_fragment)
        .filter(|value| !value.is_empty());

    let variant = if is_thumbnail_request(request) {
        "thumbnail".to_string()
    } else if request.format.eq_ignore_ascii_case("mp3")
        || request.quality.eq_ignore_ascii_case("audio")
    {
        "audio-mp3".to_string()
    } else if let Some(format_id) = format_tag {
        format!("{quality}-{format_id}")
    } else {
        quality
    };

    let ext = if is_thumbnail_request(request) {
        "jpg"
    } else if request.format.eq_ignore_ascii_case("mp3")
        || request.quality.eq_ignore_ascii_case("audio")
    {
        "mp3"
    } else {
        "mp4"
    };
    let base = format!("{safe_title} [{variant}]");
    next_available_path(&dir, &base, ext).display().to_string()
}

/// Sanitize a string for safe use in filenames — keep alphanumerics, spaces,
/// hyphens and underscores.
fn sanitize_title_for_filename(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == ' ' || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push(' ');
        }
    }
    let compact = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        "Island Video".to_string()
    } else if compact.len() > 140 {
        compact[..140].trim().to_string()
    } else {
        compact
    }
}

/// Sanitize a fragment for use in filename metadata brackets.
fn sanitize_name_fragment(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '+' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }

    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "unknown".to_string()
    } else if trimmed.len() > 64 {
        trimmed[..64].to_string()
    } else {
        trimmed.to_string()
    }
}

/// Find the next non-colliding file path with `(2)`, `(3)`, … suffixes.
fn next_available_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{base}.{ext}"));
    if !first.exists() {
        return first;
    }
    for n in 2..10_000 {
        let candidate = dir.join(format!("{base} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{base} (overflow).{ext}"))
}
