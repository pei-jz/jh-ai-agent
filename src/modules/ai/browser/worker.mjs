// DEPRECATED LOCATION — the Playwright worker now lives at
//   src-tauri/resources/browser_worker.mjs
// It is embedded into the Rust binary via include_str! (commands/mcp.rs,
// `browser_worker_path`) and materialised under the app config dir at runtime.
// This stub remains only so stale references fail loudly instead of silently
// running an outdated copy. Do not add code here.

throw new Error(
    'browser worker moved to src-tauri/resources/browser_worker.mjs — ' +
    'it is provisioned at runtime via the browser_worker_path command.'
);
