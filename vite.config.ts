import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.ts'],
    globals: false
  },
  build: {
    target: 'es2022',
    sourcemap: true
  }
});
