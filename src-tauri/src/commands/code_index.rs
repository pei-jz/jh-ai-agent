// code_index — the structural index the agent QUERIES, as opposed to the memory
// it is given.
//
// ── Why this is not more cards ─────────────────────────────────────────────
// The first study pass wrote one card per symbol into cards.jsonl and produced
// 716 rows of `setSel → NewFileModal.js:307`. Two different mistakes were behind
// that, and only one of them was granularity:
//
//   * a CARD is advice — "when you do X, remember Y" — and it is pushed into the
//     prompt. Symbols carry no trigger and there are tens of thousands of them,
//     so they are the wrong shape for that container.
//   * an INDEX is a lookup. Symbol granularity is right for it; you just have to
//     ASK it something instead of being handed all of it.
//
// Published work agrees on both halves: a tree-sitter graph exposed as a query
// tool reports ~10x fewer tokens and ~2x fewer tool calls than reading files,
// with sub-millisecond structural queries (Codebase-Memory, arXiv:2603.27277).
// The savings come from querying — the same data injected would be a 25 MB
// prompt.
//
// ── Why SQLite and not another JSONL ───────────────────────────────────────
// A 10,000-file project holds ~100k symbols. JSON Lines means reading and
// parsing all of it to answer "where is licenseState", on every run. Here the
// same question is an index seek.
//
// ── What is stored ─────────────────────────────────────────────────────────
//   files    path → content hash, so a re-index touches only what changed
//   symbols  name → path:line (declarations, not call sites)
//   edges    src → dst, typed: `imports` for code, `references` for a formula
//            that reads another sheet. Different extractors, one table, because
//            "what depends on this" is the same question either way.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

use crate::path_guard::PathGuard;

#[derive(Debug, Deserialize)]
pub struct IndexSymbol {
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub line: i64,
    #[serde(default)]
    pub exported: bool,
}

#[derive(Debug, Deserialize)]
pub struct IndexFile {
    pub path: String,
    /// Content hash. Unchanged hash ⇒ the caller should not have sent this file.
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub lang: String,
    #[serde(default)]
    pub symbols: Vec<IndexSymbol>,
    /// Outgoing edges, as (destination, kind) pairs.
    #[serde(default)]
    pub deps: Vec<(String, String)>,
}

#[derive(Debug, Serialize)]
pub struct SymbolHit {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub line: i64,
    pub exported: bool,
}

#[derive(Debug, Serialize)]
pub struct DepHit {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
pub struct IndexStats {
    pub files: i64,
    pub symbols: i64,
    pub edges: i64,
    pub languages: Vec<(String, i64)>,
}

fn db_path(workspace: &str) -> PathBuf {
    PathBuf::from(workspace).join(".agent").join("memory").join("index.db")
}

/// Open (creating if needed) the workspace's index, with the schema applied.
///
/// The guard check is on the DIRECTORY we create, matching every other write
/// path: the index lives inside `.agent`, which the Memory tab registers when
/// the user acts on that workspace.
fn open(workspace: &str, guard: &PathGuard) -> Result<Connection, String> {
    if workspace.trim().is_empty() {
        return Err("workspace must not be empty".to_string());
    }
    let path = db_path(workspace);
    let dir = path.parent().ok_or("bad index path")?;
    guard.ensure_allowed(dir)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    // Make the directory ignore itself. The agent studies OTHER people's
    // repositories, and none of them have a rule for `.agent/` — without this,
    // studying a project drops an untracked binary into someone's working tree
    // and the first they hear of it is `git status`. The index is a derived
    // cache; committing it would version a build artifact that is stale as soon
    // as anyone edits a file.
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(
            &ignore,
            "# Derived cache — rebuilt by Settings > Memory > Study.\n*.db\n*.db-wal\n*.db-shm\n",
        );
    }

    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    // WAL so a read during a long index pass does not block, and NORMAL sync
    // because this is a derived cache: losing the tail of it costs a re-index,
    // never user data.
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
    conn.pragma_update(None, "synchronous", "NORMAL").map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            hash TEXT NOT NULL,
            lang TEXT,
            indexed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS symbols (
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT,
            line INTEGER,
            exported INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS idx_sym_path ON symbols(path);
        CREATE TABLE IF NOT EXISTS edges (
            src TEXT NOT NULL,
            dst TEXT NOT NULL,
            kind TEXT NOT NULL,
            PRIMARY KEY (src, dst, kind)
        );
        CREATE INDEX IF NOT EXISTS idx_edge_dst ON edges(dst);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Content hashes of everything already indexed.
///
/// The caller diffs this against the tree and re-parses only what changed, which
/// is what makes a second pass cheap. Reported as pairs rather than a map so the
/// order is stable for tests.
#[tauri::command]
pub async fn index_hashes(
    workspace: String,
    guard: State<'_, PathGuard>,
) -> Result<Vec<(String, String)>, String> {
    let conn = open(&workspace, &guard)?;
    let mut st = conn
        .prepare("SELECT path, hash FROM files")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Upsert a batch of parsed files. One call, not one per file: 400 files meant
/// 400 IPC round trips and 400 connection opens.
#[tauri::command]
pub async fn index_put_files(
    workspace: String,
    files: Vec<IndexFile>,
    guard: State<'_, PathGuard>,
) -> Result<usize, String> {
    let mut conn = open(&workspace, &guard)?;
    let now = chrono_now();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut n = 0usize;
    for f in &files {
        if f.path.trim().is_empty() {
            continue;
        }
        // Replace wholesale: a re-parsed file's old symbols are not history, they
        // are a stale copy of the same thing.
        tx.execute("DELETE FROM symbols WHERE path = ?1", params![f.path])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM edges WHERE src = ?1", params![f.path])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO files (path, hash, lang, indexed_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, lang=excluded.lang, indexed_at=excluded.indexed_at",
            params![f.path, f.hash, f.lang, now],
        )
        .map_err(|e| e.to_string())?;

        for s in &f.symbols {
            if s.name.trim().is_empty() {
                continue;
            }
            tx.execute(
                "INSERT INTO symbols (path, name, kind, line, exported) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![f.path, s.name, s.kind, s.line, s.exported as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        for (dst, kind) in &f.deps {
            if dst.trim().is_empty() {
                continue;
            }
            tx.execute(
                "INSERT OR IGNORE INTO edges (src, dst, kind) VALUES (?1, ?2, ?3)",
                params![f.path, dst, kind],
            )
            .map_err(|e| e.to_string())?;
        }
        n += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

/// Drop everything for files that are no longer in the tree.
///
/// `truncated` is the caller telling us the file list is NOT the whole tree —
/// the glob hit its cap. Deleting against a partial list would retire files
/// the tree still has, so a truncated pass prunes NOTHING: the old index is
/// kept, new entries are upserted beside it, and the gap is closed by the
/// next full pass.
#[tauri::command]
pub async fn index_prune(
    workspace: String,
    live_paths: Vec<String>,
    truncated: Option<bool>,
    guard: State<'_, PathGuard>,
) -> Result<usize, String> {
    if truncated.unwrap_or(false) {
        return Ok(0);
    }
    let mut conn = open(&workspace, &guard)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("CREATE TEMP TABLE live(path TEXT PRIMARY KEY)", [])
        .map_err(|e| e.to_string())?;
    {
        let mut ins = tx
            .prepare("INSERT OR IGNORE INTO live(path) VALUES (?1)")
            .map_err(|e| e.to_string())?;
        for p in &live_paths {
            ins.execute(params![p]).map_err(|e| e.to_string())?;
        }
    }
    let gone: usize = tx
        .execute("DELETE FROM files WHERE path NOT IN (SELECT path FROM live)", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM symbols WHERE path NOT IN (SELECT path FROM live)", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM edges WHERE src NOT IN (SELECT path FROM live)", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DROP TABLE live", []).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(gone)
}

/// Find where a name is DECLARED.
///
/// Exact matches first, then prefix, then substring — a search for `licenseState`
/// should not bury the definition under thirty names that merely contain it.
#[tauri::command]
pub async fn index_find_symbol(
    workspace: String,
    query: String,
    kind: Option<String>,
    limit: Option<usize>,
    guard: State<'_, PathGuard>,
) -> Result<Vec<SymbolHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("query must not be empty".to_string());
    }
    let lim = limit.unwrap_or(40).clamp(1, 200) as i64;
    let conn = open(&workspace, &guard)?;
    let kind_filter = kind.unwrap_or_default();

    let sql = "SELECT name, kind, path, line, exported FROM symbols
               WHERE name LIKE ?1 ESCAPE '\\' AND (?2 = '' OR kind = ?2)
               ORDER BY
                 CASE WHEN name = ?3 THEN 0
                      WHEN name LIKE ?4 ESCAPE '\\' THEN 1
                      ELSE 2 END,
                 exported DESC, length(name) ASC, path ASC
               LIMIT ?5";
    let esc = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let contains = format!("%{}%", esc);
    let prefix = format!("{}%", esc);

    let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![contains, kind_filter, q, prefix, lim], |r| {
            Ok(SymbolHit {
                name: r.get(0)?,
                kind: r.get(1).unwrap_or_default(),
                path: r.get(2)?,
                line: r.get(3).unwrap_or(0),
                exported: r.get::<_, i64>(4).unwrap_or(0) != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// What a file depends on, or what depends on it.
///
/// The reverse direction is the one worth having: "what breaks if I change this"
/// cannot be answered by reading the file, only by having looked at every other.
#[tauri::command]
pub async fn index_deps(
    workspace: String,
    path: String,
    direction: Option<String>,
    limit: Option<usize>,
    guard: State<'_, PathGuard>,
) -> Result<Vec<DepHit>, String> {
    let lim = limit.unwrap_or(60).clamp(1, 500) as i64;
    let conn = open(&workspace, &guard)?;
    let reverse = direction.as_deref().unwrap_or("out") == "in";
    let sql = if reverse {
        "SELECT src, kind FROM edges WHERE dst = ?1 ORDER BY src LIMIT ?2"
    } else {
        "SELECT dst, kind FROM edges WHERE src = ?1 ORDER BY dst LIMIT ?2"
    };
    let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![path, lim], |r| {
            Ok(DepHit { path: r.get(0)?, kind: r.get(1)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Size and shape of the index — what the coverage read-out is built from.
#[tauri::command]
pub async fn index_stats(
    workspace: String,
    guard: State<'_, PathGuard>,
) -> Result<IndexStats, String> {
    let conn = open(&workspace, &guard)?;
    let one = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
    };
    let mut st = conn
        .prepare("SELECT COALESCE(lang,''), COUNT(*) FROM files GROUP BY lang ORDER BY 2 DESC")
        .map_err(|e| e.to_string())?;
    let languages = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(IndexStats {
        files: one("SELECT COUNT(*) FROM files")?,
        symbols: one("SELECT COUNT(*) FROM symbols")?,
        edges: one("SELECT COUNT(*) FROM edges")?,
        languages,
    })
}

/// UTC timestamp without pulling in a date crate for one field.
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The schema and the query rules, exercised against a real database.
    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, lang TEXT, indexed_at TEXT NOT NULL);
             CREATE TABLE symbols (path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT, line INTEGER, exported INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE edges (src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (src, dst, kind));",
        )
        .unwrap();
        conn
    }

    #[test]
    fn exact_match_outranks_a_substring_match() {
        // Searching `setSel` must not bury the declaration under `setSelection`
        // and `resetSelected`.
        let conn = mem();
        for (name, path) in [("setSelection", "a.js"), ("setSel", "b.js"), ("resetSelected", "c.js")] {
            conn.execute(
                "INSERT INTO symbols (path, name, kind, line, exported) VALUES (?1, ?2, 'function', 1, 0)",
                params![path, name],
            )
            .unwrap();
        }
        let mut st = conn
            .prepare(
                "SELECT name FROM symbols WHERE name LIKE ?1
                 ORDER BY CASE WHEN name = ?2 THEN 0 WHEN name LIKE ?3 THEN 1 ELSE 2 END,
                          exported DESC, length(name) ASC",
            )
            .unwrap();
        let got: Vec<String> = st
            .query_map(params!["%setSel%", "setSel", "setSel%"], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(got[0], "setSel");
    }

    #[test]
    fn reverse_edges_answer_what_depends_on_this() {
        let conn = mem();
        conn.execute("INSERT INTO edges VALUES ('a.js','core.js','imports')", []).unwrap();
        conn.execute("INSERT INTO edges VALUES ('b.js','core.js','imports')", []).unwrap();
        conn.execute("INSERT INTO edges VALUES ('core.js','util.js','imports')", []).unwrap();

        let mut st = conn.prepare("SELECT src FROM edges WHERE dst = ?1 ORDER BY src").unwrap();
        let dependents: Vec<String> =
            st.query_map(params!["core.js"], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(dependents, vec!["a.js", "b.js"]);

        let mut st2 = conn.prepare("SELECT dst FROM edges WHERE src = ?1").unwrap();
        let deps: Vec<String> =
            st2.query_map(params!["core.js"], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(deps, vec!["util.js"]);
    }

    #[test]
    fn one_edge_is_recorded_once_however_often_it_is_seen() {
        let conn = mem();
        conn.execute("INSERT OR IGNORE INTO edges VALUES ('a.js','b.js','imports')", []).unwrap();
        conn.execute("INSERT OR IGNORE INTO edges VALUES ('a.js','b.js','imports')", []).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn code_and_spreadsheet_edges_share_one_table() {
        // "What depends on this" is the same question whether the dependency is
        // an import or a formula reading another sheet.
        let conn = mem();
        conn.execute("INSERT INTO edges VALUES ('a.js','b.js','imports')", []).unwrap();
        conn.execute("INSERT INTO edges VALUES ('book.xlsx#Sheet1','book.xlsx#Sheet2','references')", [])
            .unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges WHERE dst LIKE '%Sheet2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}
