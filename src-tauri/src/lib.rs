// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
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

use crate::server::router::{create_router, AppState, TaskInfo};
use crate::server::auth::generate_token;
use crate::commands::indexer::IndexerState;
use crate::commands::mcp::McpState;

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

/// Compute the per-task logs directory next to `task_history.json`.
/// Returns `<config_dir>/task_logs/`.
fn task_logs_dir(history_path: &std::path::Path) -> PathBuf {
    history_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("task_logs")
}

/// Persist a task to disk: the metadata goes into the big `task_history.json`
/// (kept lean — logs stripped), while the full logs array is written to a
/// per-task sidecar `task_logs/<task_id>.json` so we don't blow up the main
/// history file (500 entries × thousands of log lines each = unreadable).
fn save_task_to_history(path: &std::path::Path, task: &TaskInfo) {
    let mut history: Vec<serde_json::Value> = if path.exists() {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default()
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
            let _ = std::fs::remove_file(logs_dir.join(format!("{}.json", id)));
        }
    }

    if let Ok(json) = serde_json::to_string_pretty(&history) {
        let _ = std::fs::write(path, json);
    }

    // Write the per-task logs sidecar. Best-effort; failures are silent so
    // they don't break the metadata write.
    let logs_dir = task_logs_dir(path);
    if !logs_dir.exists() {
        let _ = std::fs::create_dir_all(&logs_dir);
    }
    let logs_path = logs_dir.join(format!("{}.json", task.id));
    if let Ok(logs_json) = serde_json::to_string(&task.logs) {
        let _ = std::fs::write(logs_path, logs_json);
    }
}

/// Load the persisted logs for a task from its sidecar file.
/// Returns an empty Vec on any error (file missing, parse failure, etc.) —
/// the caller treats "no logs found" and "task has no logs" the same way.
pub fn load_task_logs(history_path: &std::path::Path, task_id: &str) -> Vec<serde_json::Value> {
    let logs_path = task_logs_dir(history_path).join(format!("{}.json", task_id));
    if !logs_path.exists() { return vec![]; }
    std::fs::read_to_string(&logs_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

/// Delete the persisted logs sidecar for a task (called on history deletion).
pub fn delete_task_logs(history_path: &std::path::Path, task_id: &str) {
    let logs_path = task_logs_dir(history_path).join(format!("{}.json", task_id));
    let _ = std::fs::remove_file(logs_path);
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(IndexerState::default())
        .manage(McpState::default())
        .setup(|app| {
            // Save settings directory path
            let config_dir = app.path().app_config_dir().unwrap_or_default();
            if !config_dir.exists() {
                let _ = std::fs::create_dir_all(&config_dir);
            }
            let config_path = config_dir.join("ai_config.json");

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
                                    if let Some(prompt) = ws_packet["data"].get("prompt_tokens").and_then(|t| t.as_u64()) {
                                        task.token_usage.prompt_tokens = prompt as u32;
                                    }
                                    if let Some(completion) = ws_packet["data"].get("completion_tokens").and_then(|t| t.as_u64()) {
                                        task.token_usage.completion_tokens = completion as u32;
                                    }
                                    task.token_usage.total_tokens = task.token_usage.prompt_tokens + task.token_usage.completion_tokens;
                                }
                                "complete" => {
                                    task.status = "completed".to_string();
                                    task.progress = 1.0;
                                    task.completed_at = Some(Local::now().to_rfc3339());
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
                            if is_terminal {
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

            // ── Global shortcut: Ctrl+Shift+Space → show search bar ──
            let shortcut_handle = app.handle().clone();
            app.handle()
                .global_shortcut()
                .on_shortcut(
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space),
                    move |_app, _sc, event| {
                        if event.state() == ShortcutState::Pressed {
                            // Make sure the window is visible before emitting
                            if let Some(w) = shortcut_handle.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = shortcut_handle.emit("show-search", ());
                        }
                    },
                )?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_api_token,
            get_server_port,
            // AI commands
            commands::ai::llm_chat_native,
            commands::ai::get_ai_config,
            commands::ai::save_ai_config,
            commands::ai::set_rag_approval,
            commands::ai::export_connection_config,
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
            commands::search::grep_search,
            commands::search::glob_files,
            commands::search::delete_file,
            commands::search::move_file,
            // Shell operations
            commands::shell::run_command,
            // MCP process management (bypasses shell plugin scope restrictions)
            commands::mcp::mcp_spawn,
            commands::mcp::mcp_write,
            commands::mcp::mcp_kill,
            // Skill file management
            commands::ai::get_app_config_dir,
            commands::ai::list_skill_files,
            commands::ai::read_skill_file,
            commands::ai::write_skill_file,
            commands::ai::delete_skill_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
