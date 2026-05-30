import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
    clearScreen: false,
    root: 'src',
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
