import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The lazy-loaded SwaggerPanel chunk is swagger-ui itself (~1.3 MB) and can't be split further; keep the
    // warning just above it so any other chunk growing past that still gets flagged.
    chunkSizeWarningLimit: 1400,
  },
  server: {
    proxy: {
      '^/api/': 'http://localhost:3000',
      '^/admin/': 'http://localhost:3000',
    },
  },
});
