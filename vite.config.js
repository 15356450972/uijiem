import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // Crucial for Electron loaded from local file path
  server: {
    port: 5174,
    strictPort: true,
    watch: {
      ignored: [
        '**/_wizstar_data_test/**',
        '**/wizstar/**',
        '**/.venv/**',
        '**/.venv-build/**',
        '**/py-build/**',
        '**/py-dist/**',
        '**/nuitka-dist/**',
        '**/build/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/.cache/**',
        '**/oiioii-sdk/**',
        '**/quickframe-sdk-full/**',
        '**/dola-video-standalone/**',
        '**/dola-send-task-kit/**',
        '**/*.db',
        '**/*.db-wal',
        '**/*.db-shm',
      ],
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
});
