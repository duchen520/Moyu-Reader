import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_'],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/lucide-react')) return 'lucide-icons';
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'react-vendor';
        },
      },
    },
  },
});
