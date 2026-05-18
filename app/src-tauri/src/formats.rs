//! Format discovery via yt-dlp.
//!
//! Runs `yt-dlp --dump-json` against a video URL and parses the returned
//! format metadata into a ranked list of [`FormatOption`] entries that the
//! extension can display in its quality selector.

use std::collections::{BTreeMap, HashMap};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;
use tokio::process::Command;
use tracing::info;

use crate::downloader::resolve_binary;
use crate::models::FormatOption;

/// Maximum time allowed for the format probe subprocess.
const FORMAT_PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// YouTube extractor arguments — shared with downloader.
const EXTRACTOR_ARGS: &str = "youtube:player_client=android_vr,web_safari,android,web";
const VIDEO_HEIGHT_PRESETS: [u16; 5] = [2160, 1440, 1080, 720, 360];
const MAX_AUDIO_PRESETS: usize = 3;
const MAX_THUMBNAIL_PRESETS: usize = 2;

static THUMBNAIL_SELECTOR_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Internal representation of a video stream candidate.
#[derive(Debug, Clone)]
struct VideoCandidate {
    format_id: String,
    height: u16,
    fps: u16,
    tbr: f64,
    ext: String,
    protocol: String,
    vcodec: String,
    has_audio: bool,
    filesize: Option<u64>,
}

/// Internal representation of an audio stream candidate.
#[derive(Debug, Clone)]
struct AudioCandidate {
    format_id: String,
    abr: f64,
    ext: String,
    filesize: Option<u64>,
}

/// Internal representation of a thumbnail candidate.
#[derive(Debug, Clone)]
struct ThumbnailCandidate {
    width: u16,
    height: u16,
    ext: String,
    url: String,
}

/// Fetch available download formats for a video URL.
///
/// Returns a list of [`FormatOption`] entries sorted with the best quality
/// first, followed by per-resolution options and an audio-only option.
pub async fn fetch_formats(url: &str) -> Result<Vec<FormatOption>> {
    let yt_dlp = resolve_binary("yt-dlp")?;
    info!(url, binary = %yt_dlp.display(), "format probe start");

    let output = tokio::time::timeout(
        FORMAT_PROBE_TIMEOUT,
        Command::new(yt_dlp)
            .arg("--dump-json")
            .arg("--no-warnings")
            .arg("--extractor-args")
            .arg(EXTRACTOR_ARGS)
            .arg(url)
            .output(),
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "format probe timed out after {}s",
            FORMAT_PROBE_TIMEOUT.as_secs()
        )
    })?
    .context("failed to run yt-dlp --dump-json")?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(anyhow::anyhow!("yt-dlp format probe failed: {err}"));
    }

    let data: Value =
        serde_json::from_slice(&output.stdout).context("invalid yt-dlp json output")?;
    let duration = data.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
    let (videos_by_height, audio_candidates, thumbnail_candidates) = parse_format_data(&data, duration);

    let result = build_format_options(
        url,
        videos_by_height,
        &audio_candidates,
        &thumbnail_candidates,
    );
    info!(url, count = result.len(), "format options built");
    for option in &result {
        info!(
            url,
            label = %option.label,
            quality = %option.quality,
            format_id = ?option.format_id,
            height = ?option.height,
            note = ?option.note,
            "format option ready"
        );
    }
    Ok(result)
}

/// Parse raw yt-dlp JSON into video and audio candidate lists.
fn parse_format_data(
    data: &Value,
    duration: f64,
) -> (
    BTreeMap<u16, Vec<VideoCandidate>>,
    Vec<AudioCandidate>,
    Vec<ThumbnailCandidate>,
) {
    let mut videos_by_height: BTreeMap<u16, Vec<VideoCandidate>> = BTreeMap::new();
    let mut audio_candidates: Vec<AudioCandidate> = Vec::new();
    let mut thumbnail_candidates: Vec<ThumbnailCandidate> = Vec::new();

    let Some(formats) = data.get("formats").and_then(Value::as_array) else {
        return (videos_by_height, audio_candidates, thumbnail_candidates);
    };

    for item in formats {
        let Some(format_id) = item
            .get("format_id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };

        let vcodec = item.get("vcodec").and_then(Value::as_str).unwrap_or("");
        let acodec = item.get("acodec").and_then(Value::as_str).unwrap_or("");
        let has_url = item.get("url").and_then(Value::as_str).is_some();
        let ext = item.get("ext").and_then(Value::as_str).unwrap_or("");
        let protocol = item.get("protocol").and_then(Value::as_str).unwrap_or("");
        let tbr = item.get("tbr").and_then(Value::as_f64).unwrap_or(0.0);
        let abr = item
            .get("abr")
            .and_then(Value::as_f64)
            .or_else(|| item.get("tbr").and_then(Value::as_f64))
            .unwrap_or(0.0);
        let fps = item.get("fps").and_then(Value::as_f64).unwrap_or(30.0) as u16;

        let mut filesize = item
            .get("filesize")
            .and_then(Value::as_u64)
            .or_else(|| item.get("filesize_approx").and_then(Value::as_u64));

        if filesize.is_none() && tbr > 0.0 && duration > 0.0 {
            filesize = Some((tbr * 1000.0 / 8.0 * duration) as u64);
        }

        if !has_url {
            continue;
        }

        // Video stream
        if vcodec != "none" {
            if let Some(height) = item.get("height").and_then(Value::as_i64) {
                if height > 0 {
                    videos_by_height
                        .entry(height as u16)
                        .or_default()
                        .push(VideoCandidate {
                            format_id: format_id.clone(),
                            height: height as u16,
                            fps,
                            tbr,
                            ext: ext.to_string(),
                            protocol: protocol.to_string(),
                            vcodec: vcodec.to_string(),
                            has_audio: acodec != "none",
                            filesize,
                        });
                }
            }
        }

        // Audio-only stream
        if vcodec == "none" && acodec != "none" {
            audio_candidates.push(AudioCandidate {
                format_id: format_id.clone(),
                abr,
                ext: ext.to_string(),
                filesize,
            });
        }
    }

    if let Some(thumbnails) = data.get("thumbnails").and_then(Value::as_array) {
        for item in thumbnails {
            let width = item
                .get("width")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(u16::MAX as u64) as u16;
            let height = item
                .get("height")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(u16::MAX as u64) as u16;
            let ext = item
                .get("ext")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("jpg")
                .to_string();
            let Some(url) = item
                .get("url")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
            else {
                continue;
            };

            if width > 0 || height > 0 {
                thumbnail_candidates.push(ThumbnailCandidate {
                    width,
                    height,
                    ext,
                    url,
                });
            }
        }
    }

    (videos_by_height, audio_candidates, thumbnail_candidates)
}

/// Build the final list of user-facing format options.
fn build_format_options(
    source_url: &str,
    videos_by_height: BTreeMap<u16, Vec<VideoCandidate>>,
    audio_candidates: &[AudioCandidate],
    thumbnail_candidates: &[ThumbnailCandidate],
) -> Vec<FormatOption> {
    let mut result = Vec::new();

    for target_height in VIDEO_HEIGHT_PRESETS {
        let Some(candidates) = videos_by_height.get(&target_height) else {
            continue;
        };
        let Some(best_video) = candidates
            .iter()
            .max_by(|l, r| rank_video_candidate(l).cmp(&rank_video_candidate(r)))
        else {
            continue;
        };

        let selector: Option<String> = if best_video.has_audio {
            Some(best_video.format_id.clone())
        } else {
            None
        };

        let merge_note = if best_video.has_audio {
            if is_stream_protocol(&best_video.protocol) {
                "progressive HLS stream"
            } else {
                "progressive stream"
            }
        } else {
            "video+audio merge"
        };

        result.push(FormatOption {
            label: format!("{}p", best_video.height),
            media_type: "video".to_string(),
            format: "mp4".to_string(),
            quality: format!("{}p", best_video.height),
            format_id: selector,
            width: None,
            height: Some(best_video.height),
            note: Some(format!(
                "{} • source {} • {:.0} kbps",
                merge_note, best_video.ext, best_video.tbr
            )),
            filesize: best_video.filesize,
            vcodec: Some(best_video.vcodec.clone()),
        });
    }

    let mut audio_options = audio_candidates.to_vec();
    audio_options.sort_by_key(rank_audio_candidate);
    audio_options.dedup_by_key(|candidate| (candidate.abr.round() as u64, candidate.ext.clone()));
    for candidate in audio_options.into_iter().rev().take(MAX_AUDIO_PRESETS) {
        let abr = candidate.abr.round() as u64;
        let label = if abr > 0 {
            format!("{abr} kbps")
        } else {
            "Audio stream".to_string()
        };
        result.push(FormatOption {
            label,
            media_type: "audio".to_string(),
            format: "mp3".to_string(),
            quality: if abr > 0 {
                format!("{abr}kbps")
            } else {
                "audio".to_string()
            },
            format_id: Some(candidate.format_id),
            width: None,
            height: None,
            note: Some(format!(
                "audio source {} • {:.0} kbps",
                candidate.ext, candidate.abr
            )),
            filesize: candidate.filesize,
            vcodec: None,
        });
    }

    let mut thumbnails = thumbnail_candidates.to_vec();
    thumbnails.sort_by_key(rank_thumbnail_candidate);
    thumbnails.dedup_by_key(|candidate| (candidate.width, candidate.height, candidate.ext.clone()));
    for candidate in thumbnails.into_iter().rev().take(MAX_THUMBNAIL_PRESETS) {
        let selector = register_thumbnail_selector(source_url, &candidate);
        result.push(FormatOption {
            label: format!("{}×{}", candidate.width, candidate.height),
            media_type: "thumbnail".to_string(),
            format: "jpg".to_string(),
            quality: format!("{}x{}", candidate.width, candidate.height),
            format_id: Some(selector),
            width: Some(candidate.width),
            height: Some(candidate.height),
            note: Some(format!("thumbnail source {}", candidate.ext)),
            filesize: None,
            vcodec: None,
        });
    }

    result
}

/// Ranking key for selecting the best video candidate at a given resolution.
/// Higher tuple = better candidate.
fn rank_video_candidate(candidate: &VideoCandidate) -> (u8, u8, u8, u16, u64) {
    let progressive_score = u8::from(candidate.has_audio);
    let direct_score = u8::from(!is_stream_protocol(&candidate.protocol));
    let mp4_score = u8::from(candidate.ext == "mp4");
    let fps_score = candidate.fps;
    let tbr_score = candidate.tbr as u64;
    (
        progressive_score,
        direct_score,
        mp4_score,
        fps_score,
        tbr_score,
    )
}

fn is_stream_protocol(protocol: &str) -> bool {
    protocol.contains("m3u8") || protocol.contains("dash")
}

/// Ranking key for selecting the best audio-only candidate.
/// Higher tuple = better candidate.
fn rank_audio_candidate(candidate: &AudioCandidate) -> (u8, u64) {
    let m4a_score = u8::from(candidate.ext == "m4a");
    let abr_score = candidate.abr as u64;
    (m4a_score, abr_score)
}

/// Ranking key for selecting the largest thumbnail candidates.
fn rank_thumbnail_candidate(candidate: &ThumbnailCandidate) -> (u16, u16) {
    (candidate.width, candidate.height)
}

fn register_thumbnail_selector(source_url: &str, candidate: &ThumbnailCandidate) -> String {
    let selector = build_thumbnail_selector(source_url, candidate);
    let mut cache = THUMBNAIL_SELECTOR_CACHE
        .lock()
        .expect("thumbnail selector cache lock poisoned");
    cache.insert(selector.clone(), candidate.url.clone());
    selector
}

fn build_thumbnail_selector(source_url: &str, candidate: &ThumbnailCandidate) -> String {
    let mut hasher = DefaultHasher::new();
    source_url.hash(&mut hasher);
    candidate.url.hash(&mut hasher);
    candidate.width.hash(&mut hasher);
    candidate.height.hash(&mut hasher);
    format!("thumb:{:x}", hasher.finish())
}

pub fn resolve_thumbnail_selector(selector: &str) -> Option<String> {
    if selector.starts_with("http://") || selector.starts_with("https://") {
        return Some(selector.to_string());
    }

    THUMBNAIL_SELECTOR_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(selector).cloned())
}
