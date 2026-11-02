import { inspect } from 'node:util';

const MASK = '[secret]';

/**
 * Wrapper for secret values (connection strings that contain a password).
 *
 * The real value can only be obtained through reveal(). JSON.stringify, template strings,
 * console/inspect, and the logger only ever see "[secret]", so credentials cannot
 * leak into logs or tool output even when a config object gets printed.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [inspect.custom](): string {
    return `Secret(${MASK})`;
  }
}
