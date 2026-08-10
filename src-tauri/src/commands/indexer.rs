use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, Runtime, State};
use ignore::WalkBuilder;
use std::path::PathBuf;

pub struct IndexerState {
    pub is_indexing: Arc<Mutex<bool>>,
}

impl Default for IndexerState {
    fn default() -> Self {
        Self {
            is_indexing: Arc::new(Mutex::new(false)),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IndexingResult {
    pub files_scanned: usize,
    pub chunks_indexed: usize,
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub path: String,
    pub text: String,
    pub score: f32,
}

/// RAG indexing has been removed. This command is a no-op stub kept for API
/// compatibility so that any existing callers do not panic.
#[tauri::command]
pub async fn init_indexer<R: Runtime>(
    _app: AppHandle<R>,
    _state: State<'_, IndexerState>,
    _path: String,
    _exclusions: Vec<String>,
    _extensions: Option<Vec<String>>,
    _model_size: Option<String>,
) -> Result<IndexingResult, String> {
    Ok(IndexingResult {
        files_scanned: 0,
        chunks_indexed: 0,
        success: false,
        message: "RAG機能は削除されました。ファイル検索にはrun_commandやread_fileツールを使用してください。".to_string(),
    })
}

/// RAG vector search has been removed. Always returns an empty result set.
#[tauri::command]
pub async fn query_workspace(
    _query: String,
    _limit: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn is_indexing(state: State<'_, IndexerState>) -> Result<bool, String> {
    Ok(*state.is_indexing.lock().await)
}

/// Returns the relative directory paths up to `max_depth` levels below `path`.
/// Uses .gitignore rules and skips common build/cache directories.
#[tauri::command]
pub async fn get_directory_structure(path: String, max_depth: usize) -> Result<Vec<String>, String> {
    let mut dirs = Vec::new();
    let root = PathBuf::from(&path);

    let walker = WalkBuilder::new(&root)
        .max_depth(Some(max_depth))
        .hidden(true)
        .git_ignore(true)
        .build();

    for entry in walker {
        if let Ok(entry) = entry {
            let p = entry.path();
            if p.is_dir() {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if ["node_modules", ".git", "target", "dist", ".agent"].contains(&name) {
                    continue;
                }
                let rel_path = p.strip_prefix(&root).unwrap_or(p).to_string_lossy().to_string();
                if !rel_path.is_empty() {
                    dirs.push(rel_path);
                }
            }
        }
    }

    dirs.sort();
    Ok(dirs)
}
