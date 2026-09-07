//! Watcher recipes on disk.
//!
//! A recipe is a named, shareable configuration of a watcher engine that
//! already exists — see docs/design/watcher-recipes.md. The layout mirrors
//! skills, for the same reason skills use it: a flat file for the common case,
//! a directory when something has to be bundled alongside.
//!
//! ```text
//! <app_config_dir>/watchers/<name>.json
//! <app_config_dir>/watchers/<name>/recipe.json
//!   └── check.py
//! ```
//!
//! This module reads and writes; it does not decide. Validation, the rule about
//! where a secret may appear, and the approval check all live in JavaScript
//! (recipeFormat.js / RecipeRegistry.js) where they can be unit-tested without
//! a filesystem — and where the same checks are applied to the built-in recipes
//! that never touch this file at all.

use std::path::{Path, PathBuf};

/// Recipes and bundled scripts are read whole into memory and hashed, so they
/// need a ceiling. Anything approaching this is not a recipe.
const MAX_BYTES: u64 = 256 * 1024;

/// Files listed per directory-form recipe, so a stray folder cannot stall the
/// panel.
const MAX_BUNDLED: usize = 50;

fn recipes_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("watchers"))
}

/// The same shape a recipe id has to satisfy in `recipeFormat.js`.
///
/// Checked here as well because this name becomes a path: `..` or a separator
/// would reach outside the recipes directory, which is the one way a file in
/// there could name something it does not contain.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .next()
            .map(|c| c.is_ascii_alphanumeric())
            .unwrap_or(false)
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && !name.contains("..")
}

fn read_capped(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(m) if m.len() <= MAX_BYTES => std::fs::read_to_string(path).unwrap_or_default(),
        _ => String::new(),
    }
}

/// The script a directory-form recipe bundles, named by `config.scriptFile`.
///
/// Read here and hashed on the JavaScript side, so that "the code the user read
/// before enabling this" and "the code that runs" can be compared. Resolved
/// against the recipe's own directory and then checked to still be inside it.
fn bundled_script(dir: &Path, json: &str) -> (String, String) {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json) else {
        return (String::new(), String::new());
    };
    let rel = parsed
        .get("config")
        .and_then(|c| c.get("scriptFile"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if rel.is_empty() {
        return (String::new(), String::new());
    }
    let target = dir.join(rel.replace('\\', "/"));
    let (Ok(canon_dir), Ok(canon_target)) = (
        std::fs::canonicalize(dir),
        std::fs::canonicalize(&target),
    ) else {
        return (String::new(), String::new());
    };
    if !canon_target.starts_with(&canon_dir) {
        return (String::new(), String::new());
    }
    (
        read_capped(&canon_target),
        canon_target.to_string_lossy().to_string(),
    )
}

/// Every recipe on disk, with its source text.
///
/// The text itself comes back rather than a parsed object: the frontend hashes
/// it for the approval check, and a re-serialized copy would not hash to the
/// same thing as the file the user read.
#[tauri::command]
pub async fn list_watcher_recipes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    let dir = recipes_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .collect();
    // Directory form first, so a `<name>/recipe.json` shadows a stale
    // `<name>.json` beside it — the same rule skills use, for the same reason:
    // the one with files bundled is the one that was meant.
    paths.sort_by_key(|p| !p.is_dir());

    for path in paths.into_iter().take(MAX_BUNDLED * 4) {
        let (name, entry, recipe_dir) = if path.is_dir() {
            let entry = path.join("recipe.json");
            if !entry.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            (name, entry, Some(path.clone()))
        } else {
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            (name, path.clone(), None)
        };

        if !valid_name(&name) || !seen.insert(name.clone()) {
            continue;
        }
        let json = read_capped(&entry);
        if json.is_empty() {
            continue;
        }
        let (script, script_path) = recipe_dir
            .as_deref()
            .map(|d| bundled_script(d, &json))
            .unwrap_or_default();

        out.push(serde_json::json!({
            "name": name,
            "path": entry.to_string_lossy(),
            "dir": recipe_dir.map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
            "json": json,
            "script": script,
            "scriptPath": script_path,
        }));
    }
    out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Ok(out)
}

/// Write (create or update) a recipe.
///
/// An existing directory-form recipe keeps its layout — writing the flat file
/// beside it would leave the bundled script attached to a recipe nothing reads.
#[tauri::command]
pub async fn write_watcher_recipe<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
    json: String,
) -> Result<String, String> {
    if !valid_name(&name) {
        return Err(format!("使えないレシピ名です: '{}'", name));
    }
    if json.len() as u64 > MAX_BYTES {
        return Err("レシピが大きすぎます。".to_string());
    }
    // Parsed before it is stored: a file that is not JSON would be listed,
    // rejected on load, and look like the recipe had vanished.
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("JSON として読めません: {}", e))?;

    let dir = recipes_dir(&app)?;
    let nested = dir.join(&name);
    let path = if nested.is_dir() {
        nested.join("recipe.json")
    } else {
        dir.join(format!("{}.json", name))
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Delete a recipe. The flat file only — a directory form may bundle scripts,
/// and removing those silently is not something a delete button should do.
#[tauri::command]
pub async fn delete_watcher_recipe<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
) -> Result<(), String> {
    if !valid_name(&name) {
        return Err(format!("使えないレシピ名です: '{}'", name));
    }
    let dir = recipes_dir(&app)?;
    let flat = dir.join(format!("{}.json", name));
    if flat.is_file() {
        return std::fs::remove_file(&flat).map_err(|e| e.to_string());
    }
    Err(format!(
        "'{}' はフォルダ形式です。中身を確認してから、フォルダごと削除してください。",
        name
    ))
}

/// The folder recipes live in, so the UI can offer to open it.
#[tauri::command]
pub async fn watcher_recipes_dir<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<String, String> {
    let dir = recipes_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_names_that_are_paths() {
        assert!(valid_name("github-actions"));
        assert!(valid_name("check.v2"));
        assert!(!valid_name("../escape"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name(""));
        assert!(!valid_name(".hidden"));
    }

    #[test]
    fn script_is_only_read_from_inside_the_recipe_dir() {
        let dir = std::env::temp_dir().join("jh-recipe-test");
        let _ = std::fs::create_dir_all(&dir);
        let json = r#"{"config":{"scriptFile":"../../secret.txt"}}"#;
        let (script, path) = bundled_script(&dir, json);
        assert!(script.is_empty());
        assert!(path.is_empty());
    }
}
