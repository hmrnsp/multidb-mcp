import { defineConfig } from 'vitest/config';

// Protocol test: runs dist/index.js as a separate process over stdio,
// exactly as Claude Code does. Run it with: npm run test:protocol
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/protocol/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
