// appVersion — the app's own version, resolved once from the Tauri runtime.
//
// The runtime reports the version from Cargo.toml (getVersion), which is the same
// source the health endpoint and the updater use. Surfacing it through one helper
// stops the version from being hard-coded in several places that then drift apart
// on release (the Sidebar used to print a literal "v0.1" while every other surface
// said "0.1.0").
//
// Cached after the first successful read: the version does not change while the
// app runs, and each MCP client hands it out during its handshake, so re-asking the
// runtime per connection is pointless.

let cached = null;

/**
 * @returns {Promise<string>} the app version, e.g. "0.1.0".
 *   Falls back to "0.1.0" in a browser/dev context where the Tauri runtime is
 *   absent (or an older binary lacks the command).
 */
export async function getAppVersion() {
    if (cached) return cached;
    try {
        const { getVersion } = await import('@tauri-apps/api/app');
        cached = await getVersion();
    } catch (_) {
        cached = '0.1.0';
    }
    return cached || '0.1.0';
}
