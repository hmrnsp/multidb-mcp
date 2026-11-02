import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Db2 integration test. Needs an ibm_db driver that can be loaded, so it runs in the dev container:
//   npm run db:up:db2 && npm run docker:build:dev
//   npm run docker:dev -- npm run test:db2
export default defineConfig({
  // node_modules in the container belongs to the image (read-only for the host user), so the cache goes in /tmp.
  cacheDir: join(tmpdir(), 'vitest-db2'),
  test: {
    environment: 'node',
    include: ['test/db2/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
