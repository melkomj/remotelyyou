import { defineConfig } from 'astro/config';

export default defineConfig({
  typescript: {
    strictMode: false
  },
  vite: {
    esbuild: {
      target: 'es2020'
    }
  }
});