import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit tests only; integration tests have their own configs (see package.json).
    include: ['test/unit/**/*.test.ts'],
  },
});
