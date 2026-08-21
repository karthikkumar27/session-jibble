import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8088,
    proxy: {
      // 127.0.0.1, not localhost: the backend binds IPv4 loopback explicitly, and
      // Node 17+ resolves "localhost" verbatim — which can hand back ::1 first and
      // fail the proxy with ECONNREFUSED.
      '/api': 'http://127.0.0.1:8089',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
