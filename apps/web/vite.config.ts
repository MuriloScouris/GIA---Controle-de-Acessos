import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Em desenvolvimento a API roda em outra porta; `/api/*` chega a ela sem o prefixo.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        rewrite: (caminho) => caminho.replace(/^\/api/, ''),
      },
    },
  },
});
