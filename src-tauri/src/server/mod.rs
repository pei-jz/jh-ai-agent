// Server module: axum HTTP server running alongside Tauri
// Provides REST API endpoints and WebSocket support for task management.

pub mod auth;
pub mod router;
pub mod config_routes;
pub mod ws;
pub mod mcp_ws;

