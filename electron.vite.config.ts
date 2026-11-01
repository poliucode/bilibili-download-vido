import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        build: { rollupOptions: { input: resolve('desktop/src/main/index.ts') } }
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        build: { rollupOptions: { input: resolve('desktop/src/preload/index.ts') } }
    },
    renderer: {
        root: resolve('desktop/src/renderer'),
        plugins: [
            react(),
            {
                name: 'development-refresh-csp',
                apply: 'serve',
                transformIndexHtml: (html) => html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
            }
        ],
        build: { rollupOptions: { input: resolve('desktop/src/renderer/index.html') } }
    }
});
