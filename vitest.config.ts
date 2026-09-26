import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // e2e/ holds Playwright specs (npm run test:e2e) — a different test
    // runner with its own incompatible test()/describe(), not unit tests.
    exclude: ['**/node_modules/**', '**/e2e/**'],
  },
});
