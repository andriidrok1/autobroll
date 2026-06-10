import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Редактор (вариант C): своё веб-приложение поверх @remotion/player.
// root = editor/, статика (видео + json) берётся из общего public/.
export default defineConfig({
  root: 'editor',
  publicDir: path.resolve(__dirname, 'public'),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {'/api': 'http://localhost:3333'},
  },
});
