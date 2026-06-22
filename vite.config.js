import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // Crucial for Electron loaded from local file path
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
});
