import { defineConfig } from 'vitest/config';

// Integration tests against the Docker databases. Run `npm run db:up` first, then: npm run test:integration
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
