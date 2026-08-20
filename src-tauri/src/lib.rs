// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::path::PathBuf;
use tauri::{Manager, Listener, Emitter};
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio::net::TcpListener;
use serde::Deserialize;
use chrono::Local;

mod server;
mod commands;
mod path_guard;

use crate::server::router::{create_router, AppState, TaskInfo};
use crate::server::auth::generate_token;
use crate::commands::indexer::IndexerState;
use crate::commands::mcp::{McpState, McpWsState};
use crate::path_guard::PathGuard;

// Tauri state to share token and port with frontend
pub struct ServerConfig {
    pub token: String,
    pub port: u16,
}

#[derive(Debug, Deserialize, Clone)]
struct BridgeEvent {
    #[serde(rename = "taskId")]
    task_id: String,
    event: String,
    data: serde_json::Value,
    priority: Option<String>,
    #[allow(dead_code)]
    timestamp: String,
}

#[tauri::command]
fn get_api_token(config: tauri::State<'_, ServerConfig>) -> String {
    config.token.clone()
}

#[tauri::command]
fn get_server_port(config: tauri::State<'_, ServerConfig>) -> u16 {
    config.port
}

#[derive(serde::Serialize)]
struct StorageUsage {
    task_history_bytes: u64,
    task_logs_bytes: u64,
    task_logs_count: u64,
    comm_log_bytes: u64,
    config_dir: String,
    log_dir: Option<String>,
}

/// Report on-disk storage used by the agent's logs/history so the UI can show
/// sizes and let the user prune. Covers task_history.json, the per-task
/// task_logs/ dir, and (if configured) the ai_communication.log file.
#[tauri::command]
fn get_storage_usage<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> StorageUsage {
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    let file_size = |p: &std::path::Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);

    let task_history_bytes = file_size(&config_dir.join("task_history.json"));

    let mut task_logs_bytes = 0u64;
    let mut task_logs_count = 0u64;
    if let Ok(rd) = std::fs::read_dir(config_dir.join("task_logs")) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_file() { task_logs_bytes += m.len(); task_logs_count += 1; }
            }
        }
    }

    let mut comm_log_bytes = 0u64;
    let mut log_dir_out = None;
    if let Ok(txt) = std::fs::read_to_string(config_dir.join("ai_config.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(ld) = v.get("log_dir").and_then(|x| x.as_str()) {
                if !ld.is_empty() {
                    log_dir_out = Some(ld.to_string());
                    comm_log_bytes = file_size(&std::path::Path::new(ld).join("ai_communication.log"));
                }
            }
        }
    }

    StorageUsage {
        task_history_bytes,
        task_logs_bytes,
        task_logs_count,
        comm_log_bytes,
        config_dir: config_dir.to_string_lossy().to_string(),
        log_dir: log_dir_out,
    }
}

/// Truncate the ai_communication.log file (if configured). Returns bytes freed.
#[tauri::command]
fn clear_comm_log<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> u64 {
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    if let Ok(txt) = std::fs::read_to_string(config_dir.join("ai_config.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(ld) = v.get("log_dir").and_then(|x| x.as_str()) {
                if !ld.is_empty() {
                    let p = std::path::Path::new(ld).join("ai_communication.log");
                    let freed = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    let _ = std::fs::write(&p, b"");
                    return freed;
                }
            }
        }
    }
    0
}

/// Bring the main app window to the foreground and hide the spotlight window.
/// Called from the spotlight overlay's "Open App" button.
#[tauri::command]
fn open_main_window<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    if let Some(sp) = app.get_webview_window("spotlight") {
        let _ = sp.hide();
    }
}

/// Register additional directory roots the backend may write to / delete within
/// / use as a shell working dir. Idempotent and additive — the frontend calls
/// this at boot (approved projects, log dir) and per agent session (workspace),
/// plus whenever the user approves an out-of-workspace write.
#[tauri::command]
fn set_allowed_roots(roots: Vec<String>, guard: tauri::State<'_, PathGuard>) {
    guard.add_roots(&roots);
}

/// Diagnostics: current allowlist snapshot.
#[tauri::command]
fn list_allowed_roots(guard: tauri::State<'_, PathGuard>) -> Vec<String> {
    guard.list()
}

/// Compute the per-task logs directory next to `task_history.json`.
/// Returns `<config_dir>/task_logs/`.
fn task_logs_dir(history_path: &std::path::Path) -> PathBuf {
    history_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("task_logs")
}

/// The sidecar: ONE JSON value per line (JSONL), appended as the task runs.
///
/// It used to be a single JSON array rewritten in full on every checkpoint. A
/// step's log entry embeds the whole conversation up to that step, so the array
/// grows O(steps^2) - in a real install one task's sidecar reached 552 MB, and
/// every checkpoint serialized and rewrote all of it while opening the task
/// parsed all of it to show the last 400 entries. One line per entry makes a
/// save an append of what is new, and a read a byte scan plus the window the
/// caller asked for.
fn task_logs_path(logs_dir: &std::path::Path, task_id: &str) -> PathBuf {
    logs_dir.join(format!("{}.jsonl", task_id))
}

/// The pre-JSONL sidecar (one big array). Still read, and converted in place the
/// first time a task using it is saved or read.
fn legacy_task_logs_path(logs_dir: &std::path::Path, task_id: &str) -> PathBuf {
    logs_dir.join(format!("{}.json", task_id))
}

/// task id -> how many entries of that task's IN-MEMORY `logs` vec are already
/// on disk. It is an index into that vector, not a line count of the file: a
/// task continued after a restart holds only its new entries in memory while the
/// file already holds the old ones.
///
/// "Not tracked" therefore means "nothing in this vector has been written yet",
/// which is why the append path may write the whole vector in that case. That
/// holds because NOTHING seeds `TaskInfo.logs` from disk - the sidecar is read
/// into responses, never back into the task.
static PERSISTED_LOG_LINES: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();

fn persisted_lines() -> &'static Mutex<HashMap<String, usize>> {
    PERSISTED_LOG_LINES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Rewrite a legacy array sidecar as JSONL, then drop the original.
///
/// Costs one full parse - the same one every open used to pay - and only ever
/// happens once per task.
fn migrate_legacy_logs(logs_dir: &std::path::Path, task_id: &str) {
    let legacy = legacy_task_logs_path(logs_dir, task_id);
    let jsonl = task_logs_path(logs_dir, task_id);
    if jsonl.exists() || !legacy.exists() {
        return;
    }
    let entries: Vec<serde_json::Value> = match std::fs::read_to_string(&legacy)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
    {
        Some(v) => v,
        // Unreadable or corrupt: leave it alone rather than deleting the only copy.
        None => return,
    };
    let mut out = String::new();
    for e in &entries {
        if let Ok(line) = serde_json::to_string(e) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    if write_atomic(&jsonl, out.as_bytes()).is_ok() {
        let _ = std::fs::remove_file(&legacy);
    }
}

/// Append the entries of `task.logs` that are not on disk yet.
///
/// Called under HISTORY_WRITE_LOCK, so reading the persisted count and appending
/// cannot interleave with another writer. A snapshot taken before an earlier
/// save (they are spawned per checkpoint) simply has nothing left to add - it
/// can never duplicate or truncate what is already written.
fn append_task_logs(logs_dir: &std::path::Path, task: &TaskInfo) {
    // Owned here rather than assumed: an append to a path whose directory does
    // not exist fails silently, and this is the only writer of that directory.
    let _ = std::fs::create_dir_all(logs_dir);
    let mut counts = persisted_lines().lock().unwrap_or_else(|p| p.into_inner());
    let start = match counts.get(&task.id) {
        Some(n) => (*n).min(task.logs.len()),
        None => {
            // First save of this task in this process: carry a legacy array file
            // over first, so the append lands after what it already holds.
            migrate_legacy_logs(logs_dir, &task.id);
            0
        }
    };
    if start >= task.logs.len() {
        counts.insert(task.id.clone(), task.logs.len());
        return;
    }

    let mut out = String::new();
    for e in &task.logs[start..] {
        if let Ok(line) = serde_json::to_string(e) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    // Appending rather than replacing also removes the truncation window a crash
    // could land in; a torn final line is skipped on read instead of costing the
    // whole file.
    let path = task_logs_path(logs_dir, &task.id);
    let appended = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(out.as_bytes())
        })
        .is_ok();
    if appended {
        counts.insert(task.id.clone(), task.logs.len());
    }
}

/// Where each entry of a sidecar begins and ends, found by a byte scan.
///
/// No JSON is parsed, and that is the point: knowing how many entries a file
/// holds — and where the last N of them start — must not cost a parse of the
/// whole file. Works on BOTH sidecar formats, which is what lets a legacy array
/// file be read as cheaply as a JSONL one instead of being converted first. The
/// first open of a 552 MB task used to pay that conversion (a full parse plus a
/// full rewrite) before it could show anything.
enum Sidecar {
    /// One entry per line.
    Lines,
    /// One JSON array holding every entry (written by builds before the
    /// append-only sidecar).
    Array,
}

fn scan_entry_ranges(
    path: &std::path::Path,
    kind: &Sidecar,
) -> std::io::Result<Vec<(u64, u64)>> {
    use std::io::Read;
    let f = std::fs::File::open(path)?;
    let mut reader = std::io::BufReader::with_capacity(1 << 20, f);
    let mut buf = vec![0u8; 1 << 20];
    let mut pos: u64 = 0;

    let mut ranges: Vec<(u64, u64)> = Vec::new();
    // Lines: where the current line started — the first one starts at byte 0.
    // Array: where the current top-level element started, and nothing is open
    // until the outer `[` has been passed. Seeding this with Some(0) for an
    // array swallowed the opening bracket into the first element, which then
    // failed to parse and vanished from the window.
    let mut start: Option<u64> = match kind {
        Sidecar::Lines => Some(0),
        Sidecar::Array => None,
    };
    // Array only. A quoted string can hold any bracket, so depth may only move
    // outside one.
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;

    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for (k, byte) in buf[..n].iter().enumerate() {
            let at = pos + k as u64;
            let b = *byte;
            match kind {
                Sidecar::Lines => {
                    if b == b'\n' {
                        // The newline itself is not part of the entry. A \r left
                        // at the end of a range is harmless — serde_json treats
                        // trailing whitespace as whitespace.
                        ranges.push((start.unwrap_or(at), at));
                        start = Some(at + 1);
                    }
                }
                Sidecar::Array => {
                    if in_string {
                        if escaped {
                            escaped = false;
                        } else if b == b'\\' {
                            escaped = true;
                        } else if b == b'"' {
                            in_string = false;
                        }
                        continue;
                    }
                    match b {
                        b'"' => {
                            if depth == 1 && start.is_none() {
                                start = Some(at);
                            }
                            in_string = true;
                        }
                        b'[' | b'{' => {
                            if depth == 1 && start.is_none() {
                                start = Some(at);
                            }
                            depth += 1;
                        }
                        b']' | b'}' => {
                            depth -= 1;
                            if depth == 1 {
                                // A nested value closed: the element ends WITH it.
                                if let Some(s) = start.take() {
                                    ranges.push((s, at + 1));
                                }
                            } else if depth == 0 {
                                // The outer array closed on a bare scalar.
                                if let Some(s) = start.take() {
                                    ranges.push((s, at));
                                }
                            }
                        }
                        b',' if depth == 1 => {
                            if let Some(s) = start.take() {
                                ranges.push((s, at));
                            }
                        }
                        b' ' | b'\t' | b'\r' | b'\n' => {}
                        _ => {
                            if depth == 1 && start.is_none() {
                                start = Some(at);
                            }
                        }
                    }
                }
            }
        }
        pos += n as u64;
    }

    if let Sidecar::Lines = kind {
        // A file not ending in a newline still holds that last entry.
        if let Some(s) = start {
            if s < pos {
                ranges.push((s, pos));
            }
        }
    }
    Ok(ranges)
}

/// A sidecar's entry index, and the file it belongs to.
///
/// Handed out behind an `Arc` because it is CACHED: the scan that produces it is
/// a pass over the whole file (0.45 s for a real 552 MB sidecar in a release
/// build), and the Task view asks for the count and then for a window — two
/// calls that used to scan twice. One scan per file per session, reused until
/// the file changes.
pub struct LogIndex {
    path: PathBuf,
    ranges: std::sync::Arc<Vec<(u64, u64)>>,
}

struct CachedIndex {
    path: PathBuf,
    len: u64,
    mtime: Option<std::time::SystemTime>,
    ranges: std::sync::Arc<Vec<(u64, u64)>>,
}

static SIDECAR_INDEX: OnceLock<Mutex<HashMap<String, CachedIndex>>> = OnceLock::new();

impl LogIndex {
    pub fn len(&self) -> usize {
        self.ranges.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ranges.is_empty()
    }

    /// Parse the entries in `[start, end)`. One seek, one read of exactly those
    /// bytes, and a parse of each entry from ITS OWN range — a legacy array may
    /// be pretty-printed, so splitting the block on newlines would not do.
    pub fn read_range(&self, start: usize, end: usize) -> Vec<serde_json::Value> {
        use std::io::{Read, Seek, SeekFrom};
        if start >= end || end > self.ranges.len() {
            return vec![];
        }
        let from = self.ranges[start].0;
        let to = self.ranges[end - 1].1;
        let mut buf = vec![0u8; (to - from) as usize];
        if std::fs::File::open(&self.path)
            .and_then(|mut f| {
                f.seek(SeekFrom::Start(from))?;
                f.read_exact(&mut buf)
            })
            .is_err()
        {
            return vec![];
        }
        self.ranges[start..end]
            .iter()
            .filter_map(|(s, e)| {
                // An entry that does not parse is a torn append, not a reason to
                // fail the whole read.
                serde_json::from_slice(&buf[(s - from) as usize..(e - from) as usize]).ok()
            })
            .collect()
    }
}

/// Index a task's sidecar — JSONL if one exists, otherwise the legacy array.
/// `None` when the task has no sidecar at all.
pub fn task_log_index(history_path: &std::path::Path, task_id: &str) -> Option<LogIndex> {
    let logs_dir = task_logs_dir(history_path);
    let jsonl = task_logs_path(&logs_dir, task_id);
    let (path, kind) = if jsonl.exists() {
        (jsonl, Sidecar::Lines)
    } else {
        let legacy = legacy_task_logs_path(&logs_dir, task_id);
        if !legacy.exists() {
            return None;
        }
        (legacy, Sidecar::Array)
    };

    // A stat is what decides whether the cached scan still describes the file.
    // An append moves both, so a live task re-indexes; a finished one never does.
    let meta = std::fs::metadata(&path).ok()?;
    let len = meta.len();
    let mtime = meta.modified().ok();

    let mut cache = SIDECAR_INDEX
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if let Some(c) = cache.get(task_id) {
        if c.path == path && c.len == len && c.mtime == mtime {
            return Some(LogIndex { path, ranges: c.ranges.clone() });
        }
    }

    let ranges = std::sync::Arc::new(scan_entry_ranges(&path, &kind).ok()?);
    cache.insert(
        task_id.to_string(),
        CachedIndex { path: path.clone(), len, mtime, ranges: ranges.clone() },
    );
    Some(LogIndex { path, ranges })
}

/// How many entries the sidecar holds, without parsing any of them.
pub fn task_log_line_count(history_path: &std::path::Path, task_id: &str) -> usize {
    task_log_index(history_path, task_id).map(|i| i.len()).unwrap_or(0)
}

/// How many entries of a task's IN-MEMORY `logs` vec are already on disk.
///
/// The persisted ones are the sidecar's LAST `n` entries (they were appended),
/// so a caller can place the whole in-memory vec in the file's index space:
/// `absolute(logs[j]) == (entry_count - n) + j`. That is what lets a task
/// continued after a restart — whose memory holds only the new entries — page
/// through its full history.
pub fn persisted_log_count(task_id: &str) -> usize {
    persisted_lines()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(task_id)
        .copied()
        .unwrap_or(0)
}

/// Load a WINDOW of a task's persisted logs.
///
/// Returns `(total_entries, index_of_first_returned, entries)`; the absolute
/// index is what the client pages backwards from. Only the requested entries are
/// parsed — everything before them is a byte scan, in either sidecar format.
pub fn load_task_logs_window(
    history_path: &std::path::Path,
    task_id: &str,
    q: &crate::server::router::LogsQuery,
) -> (usize, usize, Vec<serde_json::Value>) {
    let index = match task_log_index(history_path, task_id) {
        Some(i) => i,
        None => return (0, 0, vec![]),
    };
    let total = index.len();
    let (start, end) = crate::server::router::log_window(total, q);
    (total, start, index.read_range(start, end))
}

/// Serialize ALL writes to task_history.json.
///
/// `save_task_to_history` is a read-modify-write over one shared file and is
/// called from `std::thread::spawn` per terminal/checkpoint event. With two
/// tasks finishing close together (or one task's periodic checkpoint racing
/// another's completion), both threads read the file, each appends/updates its
/// own task, then each writes back — the second write CLOBBERS the first task's
/// entry (lost update). Worse, when the racing write catches the file mid-write
/// (partial bytes), `serde_json::from_str` fails and the code fell back to an
/// EMPTY vec — a single race then wiped the ENTIRE history file, exactly the
/// "all history gone after a forced quit" report. This global mutex makes the
/// read-modify-write atomic across all writers (any config dir, so process-wide).
static HISTORY_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Write `bytes` to `path` atomically: fill a sibling temp file, flush it to
/// the OS, then rename it over the target.
///
/// `std::fs::write` TRUNCATES the target first and then streams into it, so a
/// crash — or the user force-quitting the app — mid-write leaves a half-written
/// file behind. For task_history.json that is fatal: the truncated JSON no
/// longer parses, the whole task list reads as empty, and every per-task
/// `task_logs/<id>.json` sidecar is orphaned (they are only ever deleted via an
/// entry in the history file, so the disk usage stays while the UI shows
/// nothing). A rename is atomic, so the target is always either the previous
/// complete file or the new complete one.
pub(crate) fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    // Windows' rename replaces an existing destination (MOVEFILE_REPLACE_EXISTING).
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp); // never leave a stray .tmp behind
            Err(e)
        }
    }
}

/// Persist a task to disk: the metadata goes into the big `task_history.json`
/// (kept lean — logs stripped), while the full logs array is written to a
/// per-task sidecar `task_logs/<task_id>.json` so we don't blow up the main
/// history file (500 entries × thousands of log lines each = unreadable).
fn save_task_to_history(path: &std::path::Path, task: &TaskInfo) {
    // The whole read-modify-write must be atomic w.r.t. every other writer or
    // concurrent saves drop each other's entries (and a torn read wipes the
    // file). See HISTORY_WRITE_LOCK above.
    let _guard = HISTORY_WRITE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|p| p.into_inner());

    // Read the existing history. A parse failure here used to fall back to an
    // EMPTY vec, which the write below then persisted — a single torn/corrupt
    // read permanently wiped every task. Now a corrupt file is backed up (best
    // effort) and the save proceeds with what parsed; the backup keeps the old
    // bytes recoverable instead of letting one race destroy 1.3 GB of history.
    let mut history: Vec<serde_json::Value> = if path.exists() {
        let raw = std::fs::read_to_string(path).unwrap_or_default();
        match serde_json::from_str::<Vec<serde_json::Value>>(&raw) {
            Ok(v) => v,
            Err(_) if !raw.trim().is_empty() => {
                let backup = path.with_extension("json.corrupt.bak");
                let _ = std::fs::write(&backup, &raw);
                vec![]
            }
            Err(_) => vec![], // genuinely empty/whitespace file — fine
        }
    } else {
        vec![]
    };

    let mut entry = serde_json::to_value(task).unwrap_or_default();
    if let Some(obj) = entry.as_object_mut() {
        obj.remove("logs");
    }

    // Update if exists, otherwise append
    if let Some(existing) = history.iter_mut().find(|e| {
        e.get("id").and_then(|id| id.as_str()) == Some(&task.id)
    }) {
        *existing = entry;
    } else {
        history.push(entry);
    }

    // Keep last 500 entries. Also clean up sidecar files for evicted ones.
    if history.len() > 500 {
        let logs_dir = task_logs_dir(path);
        let drain = history.len() - 500;
        let evicted: Vec<String> = history.drain(0..drain)
            .filter_map(|e| e.get("id").and_then(|id| id.as_str()).map(String::from))
            .collect();
        for id in evicted {
            let _ = std::fs::remove_file(task_logs_path(&logs_dir, &id));
            let _ = std::fs::remove_file(legacy_task_logs_path(&logs_dir, &id));
            persisted_lines().lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        }
    }

    if let Ok(json) = serde_json::to_string_pretty(&history) {
        let _ = write_atomic(path, json.as_bytes());
    }

    // Write the per-task logs sidecar. Best-effort; failures are silent so
    // they don't break the metadata write. APPEND-ONLY (see task_logs_path):
    // this used to re-serialize and rewrite every entry on every checkpoint,
    // which on a long task means writing hundreds of MB per checkpoint.
    let logs_dir = task_logs_dir(path);
    append_task_logs(&logs_dir, task);
}

/// Load the persisted logs for a task from its sidecar file.
/// Returns an empty Vec on any error (file missing, parse failure, etc.) —
/// the caller treats "no logs found" and "task has no logs" the same way.
pub fn load_task_logs(history_path: &std::path::Path, task_id: &str) -> Vec<serde_json::Value> {
    // Whole-file read, for the callers that genuinely need every entry (the WS
    // replay of a task restored after a restart). Anything paging or peeking
    // should use load_task_logs_window, which parses only what it returns.
    let (_total, _start, all) =
        load_task_logs_window(history_path, task_id, &crate::server::router::LogsQuery::default());
    all
}

/// Delete the persisted logs sidecar for a task (called on history deletion).
pub fn delete_task_logs(history_path: &std::path::Path, task_id: &str) {
    let logs_dir = task_logs_dir(history_path);
    let _ = std::fs::remove_file(task_logs_path(&logs_dir, task_id));
    let _ = std::fs::remove_file(legacy_task_logs_path(&logs_dir, task_id));
    // Drop the append bookkeeping too, or a task recreated under the same id
    // would start writing from the deleted file's length.
    persisted_lines().lock().unwrap_or_else(|p| p.into_inner()).remove(task_id);
}

fn load_task_history(path: &std::path::Path) -> Vec<TaskInfo> {
    if !path.exists() { return vec![]; }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn get_free_port() -> Option<u16> {
    // Try to bind to port 14300 first to keep connection stable across restarts
    if std::net::TcpListener::bind("127.0.0.1:14300").is_ok() {
        return Some(14300);
    }
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance guard MUST be the first plugin: launching a second
        // copy (e.g. `tauri dev` while a previous build still sits in the tray,
        // since the ✕ button hides instead of exiting) used to crash on the
        // duplicate Ctrl+Shift+Space hotkey registration. Now the second launch
        // exits immediately and the EXISTING instance shows/focuses its window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        // Signed auto-update. The plugin refuses any bundle whose minisign signature
        // does not verify against the public key in tauri.conf.json, so a compromised
        // release host cannot push code we did not sign.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Relaunch once an update has been installed.
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(IndexerState::default())
        .manage(McpState::default())
        .manage(McpWsState::default())
        .manage(PathGuard::default())
        .setup(|app| {
            // Register the toast-notification identity (Windows) so notifications
            // show "J.H AI Agent" instead of "Windows PowerShell" (dev/portable).
            commands::shell::register_notification_identity();

            // Save settings directory path
            let config_dir = app.path().app_config_dir().unwrap_or_default();
            if !config_dir.exists() {
                let _ = std::fs::create_dir_all(&config_dir);
            }
            let config_path = config_dir.join("ai_config.json");

            // ── Seed the path guard with always-allowed roots ──────────────
            // The app config dir (skills, history, session backups, artifacts)
            // and the OS temp dir must always be writable by the backend. The
            // frontend extends this list with the workspace / approved projects.
            {
                let guard = app.state::<PathGuard>();
                guard.add_root(&config_dir);
                guard.add_root(std::env::temp_dir());
            }

            // Load or generate auth token
            let mut auth_token = String::new();
            if config_path.exists() {
                if let Ok(json) = std::fs::read_to_string(&config_path) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json) {
                        if let Some(t) = val.get("connection_token").and_then(|t| t.as_str()) {
                            if !t.is_empty() {
                                auth_token = t.to_string();
                            }
                        }
                    }
                }
            }
            
            if auth_token.is_empty() {
                auth_token = generate_token();
                // Save it back to ai_config.json to persist it
                let json_str = std::fs::read_to_string(&config_path).unwrap_or_else(|_| "{}".to_string());
                if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    val["connection_token"] = serde_json::Value::String(auth_token.clone());
                    if let Ok(updated_json) = serde_json::to_string_pretty(&val) {
                        let _ = std::fs::write(&config_path, updated_json);
                    }
                }
            }
            
            // Find an open port, fallback to 14300
            let port = get_free_port().unwrap_or(14300);

            // Setup state
            let tasks = Arc::new(Mutex::new(HashMap::<String, TaskInfo>::new()));
            let task_senders = Arc::new(Mutex::new(HashMap::<String, tokio::sync::broadcast::Sender<String>>::new()));

            // Load historical tasks from previous sessions
            let history_path: PathBuf = config_dir.join("task_history.json");
            {
                let historical = load_task_history(&history_path);
                let mut map = tasks.lock().unwrap();
                for mut task in historical {
                    // Tasks that were running when the app closed are now failed
                    if task.status == "running" || task.status == "paused" {
                        task.status = "failed".to_string();
                        if task.completed_at.is_none() {
                            task.completed_at = Some(Local::now().to_rfc3339());
                        }
                    }
                    map.insert(task.id.clone(), task);
                }
            }

            let app_state = AppState {
                auth_token: auth_token.clone(),
                port,
                tasks: tasks.clone(),
                task_senders: task_senders.clone(),
                config_path,
                history_path: history_path.clone(),
                app_handle: app.handle().clone(),
            };

            // Manage server config for Tauri commands
            app.manage(ServerConfig {
                token: auth_token.clone(),
                port,
            });

            // Start Axum server in a background thread
            let router = create_router(app_state);
            let addr = format!("127.0.0.1:{}", port);
            
            let server_token = auth_token.clone();
            tauri::async_runtime::spawn(async move {
                let listener = TcpListener::bind(&addr).await.expect("Failed to bind port");
                println!("J.H AI Agent server running on http://{}", addr);
                println!("J.H AI Agent token: {}", server_token);
                axum::serve(listener, router).await.unwrap();
            });

            // Listen for events from tauri Webview and bridge them to WebSocket client
            let tasks_bridge = tasks.clone();
            let senders_bridge = task_senders.clone();
            let history_path_bridge = history_path.clone();
            // When each in-flight task was last checkpointed to disk (see below).
            let checkpoints_bridge: std::sync::Arc<std::sync::Mutex<
                std::collections::HashMap<String, std::time::Instant>>> = Default::default();
            
            app.listen("task-event-bridge", move |event| {
                if let Ok(payload) = serde_json::from_str::<BridgeEvent>(event.payload()) {
                    let task_id = payload.task_id.clone();
                    let event_type = payload.event.clone();

                    let ws_packet = serde_json::json!({
                        "event": event_type,
                        "data": payload.data,
                        "priority": payload.priority,
                        "timestamp": Local::now().to_rfc3339()
                    });

                    // 1. Update task info in-memory, store log entry, snapshot for persistence
                    let is_terminal = event_type == "complete" || event_type == "error";
                    // A task used to reach disk ONLY on a terminal event, so anything
                    // that did not finish cleanly was never persisted at all: a run
                    // still in flight when the app closed, and — because an abort
                    // arrives as a `status` event rather than complete/error — every
                    // aborted task too. Both vanished from Monitor on the next start,
                    // since the in-memory map is all they ever lived in.
                    //
                    // So a task is ALSO snapshotted periodically while it runs. The
                    // whole history file is rewritten per save, hence the throttle:
                    // often enough that a crash costs seconds of trace, rarely enough
                    // that a chatty run is not doing disk I/O per tool call.
                    let aborted = event_type == "status"
                        && ws_packet["data"].get("status").and_then(|s| s.as_str()) == Some("aborted");
                    let due_for_checkpoint = {
                        const CHECKPOINT_EVERY: std::time::Duration = std::time::Duration::from_secs(10);
                        let mut seen = checkpoints_bridge.lock().unwrap();
                        let now = std::time::Instant::now();
                        match seen.get(&task_id) {
                            Some(last) if now.duration_since(*last) < CHECKPOINT_EVERY => false,
                            _ => { seen.insert(task_id.clone(), now); true }
                        }
                    };
                    let task_snapshot_for_history = {
                        let mut tasks = tasks_bridge.lock().unwrap();
                        let mut snapshot = None;
                        if let Some(task) = tasks.get_mut(&task_id) {
                            match event_type.as_str() {
                                "status" => {
                                    if let Some(status) = ws_packet["data"].get("status").and_then(|s| s.as_str()) {
                                        task.status = status.to_string();
                                    }
                                    if let Some(progress) = ws_packet["data"].get("progress").and_then(|p| p.as_f64()) {
                                        task.progress = progress as f32;
                                    }
                                }
                                "token_usage" => {
                                    // ACCUMULATE across LLM calls. Each token_usage event is
                                    // ONE call's usage; the task total is the sum of all calls.
                                    // (Previously these were assignments, so the persisted task
                                    // kept only the LAST step's usage — usually a tool-only step
                                    // with ~0 tokens → the "Tokens: 0" bug on completed tasks.)
                                    if let Some(prompt) = ws_packet["data"].get("prompt_tokens").and_then(|t| t.as_u64()) {
                                        task.token_usage.prompt_tokens = task.token_usage.prompt_tokens.saturating_add(prompt as u32);
                                    }
                                    if let Some(completion) = ws_packet["data"].get("completion_tokens").and_then(|t| t.as_u64()) {
                                        task.token_usage.completion_tokens = task.token_usage.completion_tokens.saturating_add(completion as u32);
                                    }
                                    // Accumulate cache tokens too, so the persisted/reloaded task
                                    // summary matches the per-step cache counts (was: never summed →
                                    // header showed ⚡0 while steps showed ⚡N).
                                    if let Some(cr) = ws_packet["data"].get("cache_read_input_tokens").and_then(|t| t.as_u64()) {
                                        task.token_usage.cache_read_input_tokens = task.token_usage.cache_read_input_tokens.saturating_add(cr as u32);
                                    }
                                    if let Some(cc) = ws_packet["data"].get("cache_creation_input_tokens").and_then(|t| t.as_u64()) {
                                        task.token_usage.cache_creation_input_tokens = task.token_usage.cache_creation_input_tokens.saturating_add(cc as u32);
                                    }
                                    task.token_usage.total_tokens = task.token_usage.prompt_tokens + task.token_usage.completion_tokens;

                                    // Attribute this call's tokens to the MODEL that
                                    // produced them, so cost can later be priced with
                                    // that model's own rates (a task may escalate
                                    // tiers, so the task-level total is mixed-model).
                                    if let Some(model) = ws_packet["data"].get("model").and_then(|m| m.as_str()) {
                                        if !model.is_empty() {
                                            let d = &ws_packet["data"];
                                            let get = |k: &str| d.get(k).and_then(|t| t.as_u64()).unwrap_or(0) as u32;
                                            let mu = task.model_usage.entry(model.to_string()).or_default();
                                            mu.prompt_tokens = mu.prompt_tokens.saturating_add(get("prompt_tokens"));
                                            mu.completion_tokens = mu.completion_tokens.saturating_add(get("completion_tokens"));
                                            mu.cache_read_input_tokens = mu.cache_read_input_tokens.saturating_add(get("cache_read_input_tokens"));
                                            mu.cache_creation_input_tokens = mu.cache_creation_input_tokens.saturating_add(get("cache_creation_input_tokens"));
                                            mu.total_tokens = mu.prompt_tokens + mu.completion_tokens;
                                        }
                                    }
                                }
                                "complete" => {
                                    task.status = "completed".to_string();
                                    task.progress = 1.0;
                                    task.completed_at = Some(Local::now().to_rfc3339());
                                    // Persist the structured result summary for the API + Result tab.
                                    if let Some(rs) = ws_packet["data"].get("resultSummary") {
                                        if !rs.is_null() {
                                            task.result_summary = Some(rs.clone());
                                        }
                                    }
                                    // Persist per-file before/after content so a task loaded
                                    // from HISTORY can still re-open its diffs (the WS packet
                                    // reaches live clients, but only this field survives to disk).
                                    if let Some(mf) = ws_packet["data"].get("modifiedFiles") {
                                        if !mf.is_null() {
                                            task.modified_files = mf.as_array()
                                                .cloned()
                                                .unwrap_or_default();
                                        }
                                    }
                                }
                                "error" => {
                                    task.status = "failed".to_string();
                                    task.completed_at = Some(Local::now().to_rfc3339());
                                }
                                _ => {}
                            }
                            // Store all non-stream events for historical replay
                            if event_type != "stream" {
                                task.logs.push(ws_packet.clone());
                            }
                            if is_terminal || aborted || due_for_checkpoint {
                                snapshot = Some(task.clone());
                            }
                        }
                        snapshot
                    }; // lock released here

                    // Persist terminal tasks to disk (in background thread)
                    if let Some(snapshot) = task_snapshot_for_history {
                        let hist_path = history_path_bridge.clone();
                        std::thread::spawn(move || save_task_to_history(&hist_path, &snapshot));
                    }

                    // 2. Relay the JSON packet to corresponding WebSocket client
                    {
                        let senders = senders_bridge.lock().unwrap();
                        if let Some(tx) = senders.get(&task_id) {
                            if let Ok(msg_str) = serde_json::to_string(&ws_packet) {
                                let _ = tx.send(msg_str);
                            }
                        }
                    }
                    // Remove sender after terminal events so WS relay loops exit cleanly
                    if is_terminal {
                        let mut senders = senders_bridge.lock().unwrap();
                        senders.remove(&task_id);
                        // Drop the checkpoint clock too, or the map grows for the life
                        // of the process.
                        checkpoints_bridge.lock().unwrap().remove(&task_id);
                    }
                }
            });

            // ── System tray setup ────────────────────────────────────
            let show_item = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .tooltip("J.H AI Agent")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            // Keep the tray icon alive for the entire app lifetime.
            // TrayIcon's Drop removes it from the system tray, so we
            // intentionally forget the handle here (one-time, tiny allocation).
            std::mem::forget(tray);

            // ── Close → hide to tray ─────────────────────────────────
            let main_win = app.get_webview_window("main").unwrap();
            let win_hide = main_win.clone();
            main_win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win_hide.hide();
                }
            });

            // ── Spotlight window (frameless, transparent, always-on-top) ──
            // Hosts ONLY the quick-search / ask-AI overlay so Ctrl+Shift+Space
            // shows just a floating modal on the desktop instead of the full app.
            // Same bundle (index.html) — main.js detects the "spotlight" label and
            // renders only the overlay. Created hidden; shown by the shortcut.
            match tauri::WebviewWindowBuilder::new(
                app.handle(),
                "spotlight",
                tauri::WebviewUrl::App("index.html".into()),
            )
                .title("J.H AI Agent — Spotlight")
                .inner_size(720.0, 580.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(true)
                // Prevent the drag-region's double-click from maximizing the
                // spotlight to fullscreen.
                .maximizable(false)
                .visible(false)
                .center()
                .build()
            {
                Ok(_) => {
                    // We intentionally DO NOT auto-hide on focus loss anymore.
                    // This allows the user to resize the frameless window (which steals focus),
                    // and more importantly, allows them to click their editor to copy-paste
                    // code without the AI answer disappearing.
                }
                Err(e) => eprintln!("Failed to create spotlight window: {}", e),
            }

            // ── Global shortcut: Ctrl+Shift+Space → show spotlight overlay ──
            // Registration can fail when ANOTHER process already holds the key —
            // most commonly a previous instance of this app still living in the
            // tray (the titlebar ✕ hides instead of exiting), or another tool.
            // That must NOT abort startup (it used to `?` → setup panic → the
            // whole app failed to launch); the spotlight shortcut is optional.
            let shortcut_handle = app.handle().clone();
            let shortcut_result = app.handle()
                .global_shortcut()
                .on_shortcut(
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space),
                    move |_app, _sc, event| {
                        if event.state() == ShortcutState::Pressed {
                            // Don't pop the floating spotlight when the user is
                            // already inside the app: if the MAIN window is focused,
                            // suppress the shortcut entirely (the in-app UI is right
                            // there). The spotlight is for quick access from OUTSIDE.
                            let main_focused = shortcut_handle
                                .get_webview_window("main")
                                .and_then(|w| w.is_focused().ok())
                                .unwrap_or(false);
                            if main_focused {
                                return;
                            }

                            // Prefer the dedicated spotlight window: show only the modal.
                            if let Some(w) = shortcut_handle.get_webview_window("spotlight") {
                                let _ = w.center();
                                let _ = w.show();
                                let _ = w.set_focus();
                                let _ = shortcut_handle.emit_to("spotlight", "show-search", ());
                            } else if let Some(w) = shortcut_handle.get_webview_window("main") {
                                // Fallback: spotlight unavailable → old in-app overlay.
                                let _ = w.show();
                                let _ = w.set_focus();
                                let _ = shortcut_handle.emit("show-search", ());
                            }
                        }
                    },
                );
            if let Err(e) = shortcut_result {
                eprintln!(
                    "[JHAI] WARNING: Ctrl+Shift+Space global shortcut registration failed: {}. \
                     The quick-search spotlight won't open via the shortcut. \
                     Likely cause: another instance of this app is still running in the tray \
                     (the ✕ button hides instead of exiting) or another program owns the key. \
                     Close the other instance and restart to restore the shortcut.",
                    e
                );
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_api_token,
            get_server_port,
            open_main_window,
            get_storage_usage,
            clear_comm_log,
            // Path guard (defense-in-depth write/exec allowlist)
            set_allowed_roots,
            list_allowed_roots,
            // AI commands
            commands::ai::llm_chat_native,
            commands::ai_config::get_ai_config,
            commands::ai_config::save_ai_config,
            commands::ai_config::set_rag_approval,
            commands::ai_config::export_connection_config,
            // RAG / Indexer
            commands::indexer::init_indexer,
            commands::indexer::query_workspace,
            commands::indexer::is_indexing,
            commands::indexer::get_directory_structure,
            // File operations
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::read_dir,
            commands::fs::create_dir,
            commands::fs::delete_dir,
            commands::fs::file_exists,
            commands::fs::select_folder,
            commands::fs::read_file_bytes,
            commands::fs::parse_excel_to_html,
            // Search & FS-mutation operations
            commands::updater::updater_pubkey,
            commands::license::verify_license,
            commands::license::license_configured,
            commands::search::grep_search,
            commands::search::glob_files,
            // Structural index: symbol lookup and dependency edges, QUERIED
            // by the agent rather than injected into its prompt.
            commands::code_index::index_hashes,
            commands::code_index::index_put_files,
            commands::code_index::index_prune,
            commands::code_index::index_find_symbol,
            commands::code_index::index_deps,
            commands::code_index::index_stats,
            // Cross-sheet formula references, fed into the same edge table
            // as code imports: a formula IS an explicit dependency.
            commands::office::spreadsheet_refs,
            commands::search::delete_file,
            commands::search::move_file,
            // Git tools (dedicated, permission-aware)
            commands::git::git_status,
            commands::git::git_diff,
            commands::git::git_log,
            commands::git::git_commit,
            // Office documents (read xlsx/docx/pptx, write xlsx)
            commands::office::read_office_document,
            commands::office::write_xlsx,
            commands::office::update_xlsx,
            commands::office::write_docx,
            // Shell operations
            commands::shell::run_command,
            commands::shell::get_shell_info,
            commands::shell::open_path_default,
            commands::shell::os_notify,
            // Web search (self-built, no API key — server-side to bypass CORS)
            commands::web::web_search,
            commands::web::fetch_url,
            // MCP process management (bypasses shell plugin scope restrictions)
            commands::mcp::mcp_spawn,
            commands::mcp::mcp_ws_send,
            commands::mcp::mcp_ws_close,
            commands::mcp::mcp_write,
            commands::mcp::mcp_kill,
            commands::mcp::mcp_http_send,
            commands::mcp::browser_worker_path,
            // Skill file management
            commands::ai_config::get_app_config_dir,
            commands::ai_config::list_skill_files,
            commands::ai_config::read_skill_file,
            commands::ai_config::write_skill_file,
            commands::ai_config::delete_skill_file,
            commands::ai_config::read_skill_resource,
            commands::ai_config::promote_skill_to_dir,
            commands::secrets::get_secret_storage_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod task_log_sidecar_tests {
    use super::*;
    use crate::server::router::LogsQuery;

    fn task_with(id: &str, n: usize) -> TaskInfo {
        let mut t = TaskInfo {
            id: id.to_string(),
            prompt: "p".to_string(),
            status: "running".to_string(),
            progress: 0.0,
            token_usage: crate::server::router::TokenUsage::default(),
            model_usage: HashMap::new(),
            started_at: "2026-01-01T00:00:00Z".to_string(),
            completed_at: None,
            workspace_path: None,
            caller: None,
            mcp_servers: None,
            result_summary: None,
            modified_files: vec![],
            logs: vec![],
        };
        t.logs = (0..n).map(|i| serde_json::json!({ "event": "status", "n": i })).collect();
        t
    }

    /// A fresh temp dir per test, and a clean bookkeeping slot for its task id:
    /// the persisted-line map is process-global, so a reused id would carry a
    /// previous test's count.
    fn fixture(name: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir()
            .join(format!("jhai_logs_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let id = format!("task-{}", name);
        persisted_lines().lock().unwrap().remove(&id);
        (dir.join("task_history.json"), id)
    }

    fn nth(v: &serde_json::Value) -> i64 {
        v.get("n").and_then(|x| x.as_i64()).unwrap_or(-1)
    }

    /// The point of the format: a checkpoint writes only what is new. The old
    /// sidecar re-serialized every entry every time, so a long task rewrote
    /// hundreds of MB per checkpoint.
    #[test]
    fn a_second_save_appends_only_the_new_entries() {
        let (hist, id) = fixture("append");
        let logs_dir = task_logs_dir(&hist);

        let mut t = task_with(&id, 3);
        append_task_logs(&logs_dir, &t);
        let after_first = std::fs::metadata(task_logs_path(&logs_dir, &id)).unwrap().len();

        t.logs.push(serde_json::json!({ "event": "status", "n": 3 }));
        append_task_logs(&logs_dir, &t);
        let after_second = std::fs::metadata(task_logs_path(&logs_dir, &id)).unwrap().len();

        let all = load_task_logs(&hist, &id);
        assert_eq!(all.len(), 4, "every entry survives");
        assert_eq!(all.iter().map(nth).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        // One entry's worth of growth, not a rewrite of all four.
        assert!(after_second > after_first);
        assert!(after_second < after_first * 2, "the second save rewrote the file");
    }

    /// A snapshot is taken per checkpoint and saved on a background thread, so a
    /// stale one can reach the writer after a newer save already landed. It must
    /// add nothing rather than duplicate or truncate.
    #[test]
    fn a_stale_snapshot_adds_nothing() {
        let (hist, id) = fixture("stale");
        let logs_dir = task_logs_dir(&hist);

        let stale = task_with(&id, 2);
        let fresh = task_with(&id, 5);
        append_task_logs(&logs_dir, &fresh);
        append_task_logs(&logs_dir, &stale);

        let all = load_task_logs(&hist, &id);
        assert_eq!(all.iter().map(nth).collect::<Vec<_>>(), vec![0, 1, 2, 3, 4]);
    }

    /// Sidecars written by earlier builds are a single JSON array. Reading one
    /// must cost the same as reading JSONL — a byte scan plus the window — and
    /// must NOT rewrite the file: converting on open is what made the FIRST open
    /// of a large task slow (a full parse plus a full rewrite before anything
    /// could be shown), which is exactly what the byte scan removes.
    #[test]
    fn a_legacy_array_sidecar_is_read_in_place() {
        let (hist, id) = fixture("legacy");
        let logs_dir = task_logs_dir(&hist);
        let _ = std::fs::create_dir_all(&logs_dir);
        let legacy = legacy_task_logs_path(&logs_dir, &id);
        let entries: Vec<serde_json::Value> =
            (0..4).map(|i| serde_json::json!({ "event": "status", "n": i })).collect();
        std::fs::write(&legacy, serde_json::to_string(&entries).unwrap()).unwrap();

        assert_eq!(task_log_line_count(&hist, &id), 4, "counted without parsing");
        let (total, start, got) = load_task_logs_window(&hist, &id, &LogsQuery::default());
        assert_eq!((total, start), (4, 0));
        assert_eq!(got.iter().map(nth).collect::<Vec<_>>(), vec![0, 1, 2, 3]);

        let (_, start, tail) = load_task_logs_window(
            &hist, &id, &LogsQuery { limit: Some(2), before: None },
        );
        assert_eq!(start, 2);
        assert_eq!(tail.iter().map(nth).collect::<Vec<_>>(), vec![2, 3]);

        assert!(legacy.exists(), "reading must not rewrite the file");
        assert!(!task_logs_path(&logs_dir, &id).exists());
    }

    /// Pretty-printed and scalar-bearing arrays are still indexed correctly: the
    /// scanner tracks JSON structure, not newlines, and a bracket inside a string
    /// must not move the depth.
    #[test]
    fn the_array_scanner_handles_whitespace_strings_and_scalars() {
        let (hist, id) = fixture("scanner");
        let logs_dir = task_logs_dir(&hist);
        let _ = std::fs::create_dir_all(&logs_dir);
        std::fs::write(
            legacy_task_logs_path(&logs_dir, &id),
            "[\n  {\"n\": 0, \"text\": \"a ] } \\\" [ {\"},\n  42,\n  {\"n\": 2}\n]\n",
        ).unwrap();

        let (total, _, got) = load_task_logs_window(&hist, &id, &LogsQuery::default());
        assert_eq!(total, 3);
        assert_eq!(got[0]["text"], "a ] } \" [ {");
        assert_eq!(got[1], serde_json::json!(42));
        assert_eq!(got[2]["n"], 2);
    }

    /// Continuing a task IS a write, and an array file cannot be appended to —
    /// so that path converts, once.
    #[test]
    fn saving_converts_a_legacy_sidecar() {
        let (hist, id) = fixture("convert");
        let logs_dir = task_logs_dir(&hist);
        let _ = std::fs::create_dir_all(&logs_dir);
        let entries: Vec<serde_json::Value> =
            (0..2).map(|i| serde_json::json!({ "event": "status", "n": i })).collect();
        std::fs::write(
            legacy_task_logs_path(&logs_dir, &id),
            serde_json::to_string(&entries).unwrap(),
        ).unwrap();

        let mut t = task_with(&id, 0);
        t.logs = vec![serde_json::json!({ "event": "status", "n": 2 })];
        append_task_logs(&logs_dir, &t);

        assert!(task_logs_path(&logs_dir, &id).exists());
        assert!(!legacy_task_logs_path(&logs_dir, &id).exists());
        assert_eq!(
            load_task_logs(&hist, &id).iter().map(nth).collect::<Vec<_>>(),
            vec![0, 1, 2],
        );
    }

    /// Continuing a task whose entries are already on disk must append after
    /// them, not overwrite them: in memory the task holds ONLY its new entries.
    #[test]
    fn continuing_a_migrated_task_keeps_the_old_entries() {
        let (hist, id) = fixture("continue");
        let logs_dir = task_logs_dir(&hist);
        let _ = std::fs::create_dir_all(&logs_dir);
        let entries: Vec<serde_json::Value> =
            (0..3).map(|i| serde_json::json!({ "event": "status", "n": i })).collect();
        std::fs::write(
            legacy_task_logs_path(&logs_dir, &id),
            serde_json::to_string(&entries).unwrap(),
        ).unwrap();

        let mut t = task_with(&id, 0);
        t.logs = vec![serde_json::json!({ "event": "status", "n": 99 })];
        append_task_logs(&logs_dir, &t);

        let all = load_task_logs(&hist, &id);
        assert_eq!(all.iter().map(nth).collect::<Vec<_>>(), vec![0, 1, 2, 99]);
    }

    /// The Task view opens on the newest slice and pages backwards from it.
    #[test]
    fn the_window_is_the_tail_with_an_absolute_start() {
        let (hist, id) = fixture("window");
        let logs_dir = task_logs_dir(&hist);
        append_task_logs(&logs_dir, &task_with(&id, 10));

        let (total, start, got) = load_task_logs_window(
            &hist, &id, &LogsQuery { limit: Some(3), before: None },
        );
        assert_eq!((total, start), (10, 7));
        assert_eq!(got.iter().map(nth).collect::<Vec<_>>(), vec![7, 8, 9]);

        let (_, start, older) = load_task_logs_window(
            &hist, &id, &LogsQuery { limit: Some(3), before: Some(7) },
        );
        assert_eq!(start, 4);
        assert_eq!(older.iter().map(nth).collect::<Vec<_>>(), vec![4, 5, 6]);
    }

    /// A crash mid-append leaves a partial last line. It costs that entry, not
    /// the file — which is the whole reason an append beats a rewrite here.
    #[test]
    fn a_torn_final_line_costs_only_itself() {
        let (hist, id) = fixture("torn");
        let logs_dir = task_logs_dir(&hist);
        append_task_logs(&logs_dir, &task_with(&id, 3));

        let path = task_logs_path(&logs_dir, &id);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"event\":\"status\",\"n\":");   // cut off mid-entry
        std::fs::write(&path, raw).unwrap();

        let all = load_task_logs(&hist, &id);
        assert_eq!(all.iter().map(nth).collect::<Vec<_>>(), vec![0, 1, 2]);
        let (total, _, got) = load_task_logs_window(&hist, &id, &LogsQuery::default());
        assert_eq!(total, 4, "the torn line still occupies a line");
        assert_eq!(got.len(), 3, "but it does not parse into an entry");
    }

    /// Deleting a task's history must take BOTH sidecar formats with it.
    #[test]
    fn deleting_removes_the_sidecar_in_either_format() {
        let (hist, id) = fixture("delete");
        let logs_dir = task_logs_dir(&hist);
        let _ = std::fs::create_dir_all(&logs_dir);
        append_task_logs(&logs_dir, &task_with(&id, 2));
        std::fs::write(legacy_task_logs_path(&logs_dir, &id), "[]").unwrap();

        delete_task_logs(&hist, &id);

        assert!(!task_logs_path(&logs_dir, &id).exists());
        assert!(!legacy_task_logs_path(&logs_dir, &id).exists());
        assert!(load_task_logs(&hist, &id).is_empty());
    }
}

#[cfg(test)]
mod history_persistence_tests {
    use super::*;

    fn sample_task(id: &str, status: &str) -> TaskInfo {
        TaskInfo {
            id: id.to_string(),
            prompt: format!("prompt {}", id),
            status: status.to_string(),
            progress: if status == "completed" { 1.0 } else { 0.0 },
            token_usage: crate::server::router::TokenUsage::default(),
            model_usage: HashMap::new(),
            started_at: "2026-01-01T00:00:00Z".to_string(),
            completed_at: if status == "completed" { Some("2026-01-01T00:01:00Z".to_string()) } else { None },
            workspace_path: Some("C:/ws".to_string()),
            caller: Some("NewTask".to_string()),
            mcp_servers: None,
            result_summary: None,
            modified_files: vec![],
            logs: vec![],
        }
    }

    fn temp_history_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jhai_test_{}_{}", name, std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join("task_history.json")
    }

    #[test]
    fn concurrent_saves_do_not_lose_entries() {
        // THE BUG: two tasks finishing close together each did a read-modify-
        // write of the shared file from separate threads. Both read the empty/
        // old file, each appended its own entry, then each wrote back — the
        // second write CLOBBERED the first task's entry (lost update). With the
        // global HISTORY_WRITE_LOCK the two saves are serialized, so both entries
        // must survive.
        let path = temp_history_path("concurrent");
        let _ = std::fs::remove_file(&path);

        let path1 = path.clone();
        let path2 = path.clone();
        let t1 = sample_task("task-a", "completed");
        let t2 = sample_task("task-b", "completed");

        let h1 = std::thread::spawn(move || save_task_to_history(&path1, &t1));
        let h2 = std::thread::spawn(move || save_task_to_history(&path2, &t2));
        h1.join().unwrap();
        h2.join().unwrap();

        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap_or_default();
        let ids: std::collections::HashSet<String> = parsed
            .iter()
            .filter_map(|e| e.get("id").and_then(|id| id.as_str()).map(String::from))
            .collect();
        assert!(ids.contains("task-a"), "task-a lost: {:?}", ids);
        assert!(ids.contains("task-b"), "task-b lost: {:?}", ids);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn update_after_append_preserves_both_entries() {
        // A checkpoint save of task-a, then a terminal save of task-a again,
        // must UPDATE rather than duplicate, and a third task must still land.
        let path = temp_history_path("update");
        let _ = std::fs::remove_file(&path);

        save_task_to_history(&path, &sample_task("task-a", "running"));
        save_task_to_history(&path, &sample_task("task-c", "completed"));
        save_task_to_history(&path, &sample_task("task-a", "completed"));

        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap_or_default();
        let ids: Vec<&str> = parsed
            .iter()
            .filter_map(|e| e.get("id").and_then(|id| id.as_str()))
            .collect();
        assert_eq!(ids, vec!["task-a", "task-c"]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_history_is_backed_up_not_silently_wiped() {
        // A torn/corrupt history file (what a racing writer left behind) must
        // NOT be replaced with an empty array — that is how 1.3 GB of task
        // history "disappeared". The corrupt bytes are preserved as a .bak so
        // the user (or a repair tool) can recover them.
        let path = temp_history_path("corrupt");
        let backup = path.with_extension("json.corrupt.bak");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&backup);
        std::fs::write(&path, "{\"truncated\": true, \"no\":").unwrap();

        save_task_to_history(&path, &sample_task("task-new", "completed"));

        // The corrupt original was preserved.
        assert!(backup.exists(), "corrupt backup missing");
        let saved_bak = std::fs::read_to_string(&backup).unwrap_or_default();
        assert!(saved_bak.contains("truncated"));
        // The live file now holds the new task (recoverable, not empty-wiped
        // into a state where the UI shows NOTHING at all).
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap_or_default();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["id"], "task-new");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&backup);
    }

    #[test]
    fn a_save_never_leaves_the_history_file_truncated() {
        // `fs::write` truncates first, so a force-quit mid-write left a partial
        // file that no longer parsed — the whole task list read as empty on the
        // next launch while task_logs/ kept its (now orphaned) gigabytes. Every
        // save must land through a temp file + rename: the target parses at all
        // times, and no .tmp is left lying around.
        let path = temp_history_path("atomic");
        let tmp = path.with_extension("json.tmp");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&tmp);

        save_task_to_history(&path, &sample_task("task-1", "completed"));
        let first = std::fs::read_to_string(&path).unwrap();

        // Overwrite the same file with a bigger payload (the shrink/grow case
        // that leaves trailing garbage without a rename).
        let mut big = sample_task("task-2", "completed");
        big.prompt = "x".repeat(50_000);
        save_task_to_history(&path, &big);

        assert!(!tmp.exists(), "temp file left behind: {:?}", tmp);
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&content)
            .expect("history must always be parseable after a save");
        assert_eq!(parsed.len(), 2);
        assert!(first.contains("task-1"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn write_atomic_replaces_an_existing_file_without_a_stray_temp() {
        let path = temp_history_path("atomic_raw");
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&path, b"old contents that are much longer than the new ones").unwrap();

        write_atomic(&path, b"new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert!(!tmp.exists());
        let _ = std::fs::remove_file(&path);
    }
}
