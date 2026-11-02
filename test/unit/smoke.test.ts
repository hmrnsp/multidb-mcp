import { describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION } from '../../src/meta.js';

// Makes sure the TypeScript + ESM + vitest chain runs on your machine.
describe('toolchain smoke test', () => {
  it('the server metadata is defined', () => {
    expect(SERVER_NAME).toBe('multidb-mcp');
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
