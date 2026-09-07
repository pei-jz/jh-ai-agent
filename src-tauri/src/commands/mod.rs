pub mod ai;
pub mod ai_providers;
pub mod ai_config;
// API keys live in the OS credential store, never in ai_config.json.
pub mod secrets;
pub mod fs;
pub mod git;
pub mod mailwatch;
// Watcher recipes on disk. See docs/design/watcher-recipes.md.
pub mod recipes;
pub mod office;
// Cell edits applied to the xlsx package itself, so nothing outside the
// edited cells can be lost. See docs/design/xlsx-fidelity.md.
pub mod xlsx_edit;
// How a generated workbook is laid out: widths, number formats, presets.
pub mod xlsx_style;
// Appending to xl/styles.xml so a cell can be restyled without a rebuild.
pub mod xlsx_stylesheet;
// Reading a sheet's formatting back out, so an edit can match it.
pub mod xlsx_inspect;
pub mod shell;
// Installed copy or portable copy — decides whether updates may be offered.
pub mod install;
pub mod indexer;
pub mod code_index;
pub mod mcp;
pub mod search;
pub mod updater;
pub mod license;
pub mod web;
