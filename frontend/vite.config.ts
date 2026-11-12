import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '..');
const target = 'http://127.0.0.1:8787';

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: { '@web': path.resolve(repo, 'web') },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [repo] },
    proxy: {
      '/api': target,
      '/mcp': target,
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      '/assets': target,
      '/docs': target,
      '/skills': target,
      '/examples': target,
      '/sdk': target,
      '/SKILL.md': target,
    },
  },
  build: {
    outDir: path.resolve(root, '../web/dist'),
    emptyOutDir: true,
    assetsDir: 'app',
  },
});
