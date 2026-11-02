import { describe, expect, it } from 'vitest';
import { DbError } from '../../src/adapters/errors.js';
import type { AuditTrace } from '../../src/observability/audit.js';
import { createLogger } from '../../src/observability/logger.js';
import type { ConnectionRegistry } from '../../src/registry/connection-registry.js';
import { withReconnect } from '../../src/tools/reconnect.js';

const log = createLogger({ write: () => undefined });
const registryWith = (state: 'connected' | 'idle' | 'error') =>
  ({ status: () => ({ state }) }) as unknown as ConnectionRegistry;

function flaky(errors: Error[]) {
  let calls = 0;
  const op = () => {
    calls += 1;
    const err = errors.shift();
    return err ? Promise.reject(err) : Promise.resolve('result');
  };
  return { op, calls: () => calls };
}
const broken = () => new DbError('connection', 'socket hang up');

describe('withReconnect', () => {
  it('an already-open connection drops: repeated once and marked retried', async () => {
    const { op, calls } = flaky([broken()]);
    const trace: AuditTrace = {};
    const context = { registry: registryWith('connected'), log, db: 'x', safeToRetry: true, trace };
    await expect(withReconnect(context, op)).resolves.toBe('result');
    expect(calls()).toBe(2);
    expect(trace.retried).toBe(true);
  });

  it('not repeated for write commands, the first connection, or non-connection errors', async () => {
    const cases = [
      { state: 'connected', safe: false, err: broken() },
      { state: 'idle', safe: true, err: broken() },
      { state: 'error', safe: true, err: broken() },
      { state: 'connected', safe: true, err: new DbError('timeout', 'lama') },
    ] as const;
    for (const { state, safe, err } of cases) {
      const { op, calls } = flaky([err]);
      const context = { registry: registryWith(state), log, db: 'x', safeToRetry: safe, trace: {} };
      await expect(withReconnect(context, op)).rejects.toBe(err);
      expect(calls()).toBe(1);
    }
  });
});
