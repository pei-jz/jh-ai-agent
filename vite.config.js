import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const host = process.env.TAURI_DEV_HOST;

// Svelte is being adopted INCREMENTALLY (see docs/design/svelte-migration.md).
// The vanilla dashboard router still owns the app shell; a migrated region is a
// Svelte component mounted into it by dashboard/svelte/mount.js. That means both
// worlds must build in the same bundle, which is all this plugin is here for —
// there is no SvelteKit, no router, and no app-wide .svelte entry point yet.
//
// Pinned to @sveltejs/vite-plugin-svelte@5: v6+ requires Vite 7/8 and this
// project is on Vite 6. Upgrading Vite is a separate decision from adopting
// Svelte, so the two are deliberately not bundled together.
export default defineConfig({
    clearScreen: false,
    root: 'src',
    // `root: 'src'` would otherwise make Vite look for src/public. The
    // tree-sitter grammars live at the repo root, and readOnlyHandlers.js loads
    // them from '/tree-sitter/' — without this they never reach dist/ and the
    // parser silently falls back to the regex backend on every built install.
    publicDir: '../public',
    plugins: [svelte()],
    server: {
        port: 1430,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                protocol: 'ws',
                host,
                port: 1431,
            }
            : undefined,
        watch: {
            ignored: ['**/src-tauri/**'],
        },
    },
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        rollupOptions: {
            output: {
                manualChunks: (id) => {
                    if (id.includes('node_modules')) {
                        if (id.includes('@tauri-apps')) return 'tauri';
                        return 'vendor';
                    }
                }
            }
        }
    },
});
