pub mod ai;
pub mod ai_providers;
pub mod ai_config;
// API keys live in the OS credential store, never in ai_config.json.
pub mod secrets;
pub mod fs;
pub mod git;
pub mod office;
pub mod shell;
pub mod indexer;
pub mod code_index;
pub mod mcp;
pub mod search;
pub mod updater;
pub mod license;
pub mod web;
