import { defineConfig } from 'astro/config';

export default defineConfig({
  build: {
    assets: '_astro'
  },
  vite: {
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  }
});