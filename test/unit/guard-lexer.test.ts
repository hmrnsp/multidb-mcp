import { describe, expect, it } from 'vitest';
import { extractTableRefs, splitStatements } from '../../src/guard/analyzer.js';
import { lex, LexError, lexVariants } from '../../src/guard/lexer.js';

const types = (sql: string, dialect: Parameters<typeof lex>[1] = 'postgresql') =>
  lex(sql, dialect, { backslashEscapes: false }).tokens.map((t) => `${t.type}:${t.value}`);

describe('lexer', () => {
  it('words, numbers, parameters, punctuation', () => {
    expect(types('SELECT a.b, 1.5e3, $1 FROM t;')).toEqual([
      'word:SELECT',
      'word:a',
      'punct:.',
      'word:b',
      'punct:,',
      'number:1.5e3',
      'punct:,',
      'param:$1',
      'word:FROM',
      'word:t',
      'punct:;',
    ]);
  });

  it('quoted identifiers per dialect', () => {
    expect(types('SELECT "a""b"')).toEqual(['word:SELECT', 'quoted:a"b']);
    expect(types('SELECT `a``b`, "text"', 'mysql')).toEqual([
      'word:SELECT',
      'quoted:a`b',
      'punct:,',
      'string:text',
    ]);
  });

  it('PostgreSQL strings: standard, E-string, dollar quote', () => {
    expect(types("SELECT 'it''s', E'a\\'b', $$x;y$$, $t$ $$ $t$")).toEqual([
      'word:SELECT',
      "string:it's",
      'punct:,',
      "string:a\\'b",
      'punct:,',
      'string:x;y',
      'punct:,',
      'string: $$ ',
    ]);
  });

  it('comments: block comments do not nest; -- and # depend on the dialect', () => {
    expect(types('SELECT /* a /* b */ 1')).toEqual(['word:SELECT', 'number:1']);
    expect(types('SELECT 1 # x', 'postgresql')).toContain('op:#');
    expect(types('SELECT 1 # x', 'mysql')).toEqual(['word:SELECT', 'number:1']);
    expect(types('SELECT 1--1', 'mysql')).toEqual([
      'word:SELECT',
      'number:1',
      'op:-',
      'op:-',
      'number:1',
    ]);
    expect(types('SELECT 1--1', 'postgresql')).toEqual(['word:SELECT', 'number:1']);
    expect(types('SELECT 1 -- x', 'mysql')).toEqual(['word:SELECT', 'number:1']);
  });

  it('MySQL executable comments are flagged', () => {
    expect(lex('SELECT /*! 1 */', 'mysql', { backslashEscapes: true }).executableComment).toBe(
      true,
    );
    expect(
      lex('SELECT /*M!100 1 */', 'mariadb', { backslashEscapes: true }).executableComment,
    ).toBe(true);
    expect(lex('SELECT /*+ hint */ 1', 'mysql', { backslashEscapes: true }).executableComment).toBe(
      false,
    );
    expect(
      lex('SELECT /*! 1 */', 'postgresql', { backslashEscapes: false }).executableComment,
    ).toBe(false);
  });

  it('an unterminated string/comment is an error', () => {
    expect(() => lex("SELECT 'x", 'postgresql', { backslashEscapes: false })).toThrow(LexError);
    expect(() => lex('SELECT /* x', 'postgresql', { backslashEscapes: false })).toThrow(
      /is not closed/,
    );
    expect(() => lex('SELECT $a$ x', 'postgresql', { backslashEscapes: false })).toThrow(LexError);
  });

  it('backslash variants: MySQL has two interpretations, Db2 one', () => {
    const variants = lexVariants("SELECT 'a\\'b'", 'mysql');
    expect(variants).toHaveLength(2);
    expect(variants[0]).not.toBeInstanceOf(LexError);
    expect(variants[1]).toBeInstanceOf(LexError);
    expect(lexVariants('SELECT 1', 'db2')).toHaveLength(1);
  });
});

describe('analyzer', () => {
  const tokens = (sql: string, dialect: Parameters<typeof lex>[1] = 'postgresql') =>
    lex(sql, dialect, { backslashEscapes: false }).tokens;

  it('splits statements at ; and drops empty ones', () => {
    expect(splitStatements(tokens('SELECT 1;; SELECT 2;'))).toHaveLength(2);
  });

  it('table references in FROM, JOIN, subqueries, and comma lists', () => {
    const refs = extractTableRefs(
      tokens(
        'SELECT * FROM app.a x, b JOIN "S"."T" ON true LEFT JOIN (SELECT * FROM c.d) q ON true, generate_series(1,2) g',
      ),
      'postgresql',
    ).map((r) => r.parts.join('.'));
    expect(refs).toEqual(['app.a', 'b', 'S.T', 'c.d']);
  });

  it('name normalization per dialect', () => {
    expect(extractTableRefs(tokens('SELECT * FROM App.Orders'), 'postgresql')[0]?.parts).toEqual([
      'app',
      'orders',
    ]);
    expect(extractTableRefs(tokens('SELECT * FROM core.orders', 'db2'), 'db2')[0]?.parts).toEqual([
      'CORE',
      'ORDERS',
    ]);
    expect(
      extractTableRefs(tokens('SELECT * FROM App.Orders', 'mysql'), 'mysql')[0]?.parts,
    ).toEqual(['App', 'Orders']);
  });

  it('target UPDATE, INSERT INTO, DELETE FROM, MERGE USING', () => {
    const refs = (sql: string) =>
      extractTableRefs(tokens(sql), 'postgresql').map((r) => r.parts.join('.'));
    expect(refs('UPDATE x.t SET a = 1')).toEqual(['x.t']);
    expect(refs('INSERT INTO x.t (a) SELECT a FROM y.u')).toEqual(['x.t', 'y.u']);
    expect(refs('DELETE FROM ONLY x.t')).toEqual(['x.t']);
    expect(refs('MERGE INTO x.t USING y.u ON true WHEN MATCHED THEN DELETE')).toEqual([
      'x.t',
      'y.u',
    ]);
  });
});
