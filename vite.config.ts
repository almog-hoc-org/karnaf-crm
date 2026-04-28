import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  root: 'apps/web',
  envDir: path.resolve(__dirname),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'apps/web/src'),
      '@lib': path.resolve(__dirname, 'lib'),
    },
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    // Pre-split big third-party deps so the app shell stays under the
    // 500 KB warning and route chunks are downloaded incrementally.
    // Vite's React plugin already inlines React; we just split the larger
    // peer libraries so the app shell stays small and they cache separately.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-router')) return 'router';
          if (id.includes('node_modules/@tanstack')) return 'query';
          if (id.includes('node_modules/@supabase')) return 'supabase';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
