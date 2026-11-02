import { DbError } from '../adapters/errors.js';
import type { AuditTrace } from '../observability/audit.js';
import type { Logger } from '../observability/logger.js';
import type { ConnectionRegistry } from '../registry/connection-registry.js';

/** Context for {@link withReconnect}. */
export interface ReconnectContext {
  registry: ConnectionRegistry;
  log: Logger;
  db: string;
  /** false for write commands: repeating one could save the change twice. */
  safeToRetry: boolean;
  trace: AuditTrace;
}

/**
 * Run the operation; if a connection that was ALREADY open turns out to be dropped (database restart,
 * a firewall cutting an idle connection), repeat it once. The pool or adapter discards the broken
 * connection, so the second attempt uses a fresh one. A failure while opening the connection for
 * the first time is not repeated: the cause is usually a stopped database or a VPN that is not
 * connected, and repeating only adds waiting time.
 */
export async function withReconnect<T>(
  context: ReconnectContext,
  op: () => Promise<T>,
): Promise<T> {
  const wasConnected = context.registry.status(context.db).state === 'connected';
  try {
    return await op();
  } catch (err) {
    if (!context.safeToRetry || !wasConnected || !isConnectionError(err)) throw err;
    context.log.warn('connection dropped; retrying once with a new connection', {
      db: context.db,
      error: err,
    });
    context.trace.retried = true;
    return op();
  }
}

/** true when the error is a classified connection error. */
export function isConnectionError(err: unknown): boolean {
  return err instanceof DbError && err.kind === 'connection';
}
