import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works under /beachhead-2000-remake/ on GitHub Pages or any sub-path.
  base: './',
  build: {
    target: 'es2022',
    assetsDir: 'bundle',
    chunkSizeWarningLimit: 2000,
  },
  server: { port: 5173, strictPort: true, host: true },
});
