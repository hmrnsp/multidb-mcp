import type { SqlDialect } from '../adapters/types.js';

/**
 * Conservative SQL lexer for the guard.
 *
 * Security principle: when the server could read the text differently, the lexer must see MORE
 * code, not less. Therefore:
 *   - block comments do not nest (they end at the first "*\/");
 *   - "--" in MySQL/MariaDB is a comment only when followed by whitespace or end of text, exactly like the server;
 *   - MySQL executable comments ("/*!" and "/*M!") are flagged, because the server RUNS their contents;
 *   - an unterminated string or comment is an error (fail closed).
 * Differences in backslash mode inside strings are handled by running the lexer twice
 * (see lexVariants) and requiring every variant to pass the guard.
 */

export type TokenType = 'word' | 'quoted' | 'string' | 'number' | 'param' | 'punct' | 'op';

/** One lexical token. */
export interface Token {
  type: TokenType;
  /** Token text. For a quoted identifier: the content without quotes. */
  value: string;
  /** value in upper case (for keywords). */
  upper: string;
  start: number;
}

/** Tokens of a SQL text, split into statements by the caller. */
export interface LexResult {
  tokens: Token[];
  /** A MySQL executable comment is present (/*! ... *\/ or /*M! ... *\/). */
  executableComment: boolean;
}

/** The SQL text cannot be tokenized (for example an unterminated string). */
export class LexError extends Error {
  override readonly name = 'LexError';

  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

/** Options that choose how string literals are interpreted. */
export interface LexOptions {
  /** A backslash escapes the next character inside an ordinary string '...'. */
  backslashEscapes: boolean;
}

const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}_$#@]/u;
const DIGIT = /[0-9]/;
const SPACE = /\s/;
const NUMBER = /^(?:0x[0-9a-f]+|[0-9]+(?:\.[0-9]*)?(?:e[+-]?[0-9]+)?|\.[0-9]+(?:e[+-]?[0-9]+)?)/i;
const DOLLAR_TAG = /^\$((?:[\p{L}_][\p{L}\p{N}_]*)?)\$/u;
const PUNCT = new Set(['(', ')', ',', ';', '.']);

const isMySqlFamily = (dialect: SqlDialect): boolean =>
  dialect === 'mysql' || dialect === 'mariadb';

/**
 * Tokenize SQL conservatively. Throws {@link LexError} when the text cannot be read safely.
 *
 * @param sql The SQL text.
 * @param dialect SQL dialect of the connection.
 * @param options How string literals are interpreted.
 */
export function lex(sql: string, dialect: SqlDialect, options: LexOptions): LexResult {
  const tokens: Token[] = [];
  const mysql = isMySqlFamily(dialect);
  const pg = dialect === 'postgresql';
  const sqlite = dialect === 'sqlite';
  let executableComment = false;
  let i = 0;
  const n = sql.length;

  const push = (type: TokenType, value: string, start: number): void => {
    tokens.push({ type, value, upper: value.toUpperCase(), start });
  };

  /** Read delimited text starting at the opening quote. Returns [content, position after the closing quote]. */
  const readDelimited = (open: number, delim: string, backslash: boolean): [string, number] => {
    let j = open + 1;
    let content = '';
    while (j < n) {
      const ch = sql[j]!;
      if (backslash && ch === '\\') {
        content += sql.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (ch === delim) {
        if (sql[j + 1] === delim) {
          content += delim;
          j += 2;
          continue;
        }
        return [content, j + 1];
      }
      content += ch;
      j += 1;
    }
    throw new LexError(`Quote ${delim} is not closed`, open);
  };

  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (SPACE.test(c)) {
      i += 1;
      continue;
    }

    // Line comment "--"
    if (c === '-' && next === '-') {
      const after = sql[i + 2];
      // MySQL: "--" is a comment only when followed by whitespace/control or end of text.
      if (!mysql || after === undefined || /\s/.test(after) || after.charCodeAt(0) < 0x20) {
        const end = sql.indexOf('\n', i);
        i = end === -1 ? n : end + 1;
        continue;
      }
    }

    // "#" comment (MySQL/MariaDB)
    if (c === '#' && mysql) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }

    // Block comment (does not nest)
    if (c === '/' && next === '*') {
      if (mysql && (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!'))) {
        executableComment = true;
      }
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new LexError('Comment /* is not closed', i);
      i = end + 2;
      continue;
    }

    // Prefixed string: E'..' (PG, backslash), N'..', X'..', B'..', U&'..' (PG)
    if (/[EeNnXxBb]/.test(c) && next === "'") {
      const backslash = pg ? c === 'E' || c === 'e' : mysql ? options.backslashEscapes : false;
      const [content, end] = readDelimited(i + 1, "'", backslash);
      push('string', content, i);
      i = end;
      continue;
    }
    if (pg && (c === 'U' || c === 'u') && next === '&' && sql[i + 2] === "'") {
      const [content, end] = readDelimited(i + 2, "'", false);
      push('string', content, i);
      i = end;
      continue;
    }

    if (c === "'") {
      const [content, end] = readDelimited(i, "'", options.backslashEscapes);
      push('string', content, i);
      i = end;
      continue;
    }

    if (c === '"') {
      if (mysql) {
        // MySQL (default sql_mode): "..." is a string.
        const [content, end] = readDelimited(i, '"', options.backslashEscapes);
        push('string', content, i);
        i = end;
      } else {
        const [content, end] = readDelimited(i, '"', false);
        push('quoted', content, i);
        i = end;
      }
      continue;
    }

    // SQLite: [name] is an identifier (MS Access compatibility), with no escapes inside.
    if (c === '[' && sqlite) {
      const end = sql.indexOf(']', i + 1);
      if (end === -1) throw new LexError('Square bracket [ is not closed', i);
      push('quoted', sql.slice(i + 1, end), i);
      i = end + 1;
      continue;
    }

    if (c === '`' && (mysql || sqlite)) {
      const [content, end] = readDelimited(i, '`', false);
      push('quoted', content, i);
      i = end;
      continue;
    }

    if (c === '$' && pg) {
      if (next !== undefined && DIGIT.test(next)) {
        let j = i + 1;
        while (j < n && DIGIT.test(sql[j]!)) j += 1;
        push('param', sql.slice(i, j), i);
        i = j;
        continue;
      }
      const tag = DOLLAR_TAG.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        const close = sql.indexOf(marker, i + marker.length);
        if (close === -1) throw new LexError(`String ${marker} is not closed`, i);
        push('string', sql.slice(i + marker.length, close), i);
        i = close + marker.length;
        continue;
      }
    }

    if (DIGIT.test(c) || (c === '.' && next !== undefined && DIGIT.test(next))) {
      const match = NUMBER.exec(sql.slice(i));
      const text = match ? match[0] : c;
      push('number', text, i);
      i += text.length;
      continue;
    }

    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j]!) && !(mysql && sql[j] === '#')) j += 1;
      push('word', sql.slice(i, j), i);
      i = j;
      continue;
    }

    if (c === '?' && !pg) {
      push('param', c, i);
      i += 1;
      continue;
    }

    if (c === '@' && next !== undefined && (WORD_START.test(next) || next === '@')) {
      // MySQL variable (@x, @@x) or Db2 marker.
      let j = i + 1;
      while (j < n && (WORD_PART.test(sql[j]!) || sql[j] === '@' || sql[j] === '.')) j += 1;
      push('param', sql.slice(i, j), i);
      i = j;
      continue;
    }

    if (PUNCT.has(c)) {
      push('punct', c, i);
      i += 1;
      continue;
    }

    push('op', c, i);
    i += 1;
  }

  return { tokens, executableComment };
}

/**
 * Run the lexer for every possible string interpretation in this dialect.
 * MySQL/MariaDB: backslash escapes on (default) and off (NO_BACKSLASH_ESCAPES).
 * PostgreSQL: standard_conforming_strings on (default) and off.
 * Db2 and SQLite: strings have no backslash escapes, so one interpretation is enough.
 * A variant that fails to lex is reported as an error; the caller decides.
 */
export function lexVariants(sql: string, dialect: SqlDialect): (LexResult | LexError)[] {
  const modes =
    dialect === 'db2' || dialect === 'sqlite'
      ? [false]
      : isMySqlFamily(dialect)
        ? [true, false]
        : [false, true];
  return modes.map((backslashEscapes) => {
    try {
      return lex(sql, dialect, { backslashEscapes });
    } catch (err) {
      if (err instanceof LexError) return err;
      throw err;
    }
  });
}
