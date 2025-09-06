import { defineConfig } from 'astro/config';

export default defineConfig({
  typescript: false,
  vite: {
    esbuild: {
      target: 'es2020'
    }
  }
});