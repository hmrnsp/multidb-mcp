import { describe, expect, it } from 'vitest';
import { hasLiteralSecret, interpolate, referencedVariables } from '../../src/config/env.js';

describe('interpolate', () => {
  const env = { PG_URL: 'postgres://u:p@h/db', PASS: 's3cret', EMPTY: '   ' };

  it('replaces ${VAR} with its value', () => {
    expect(interpolate('${PG_URL}', env)).toEqual({
      value: 'postgres://u:p@h/db',
      missing: [],
      malformed: false,
    });
    expect(interpolate('UID=a;PWD=${PASS};', env).value).toBe('UID=a;PWD=s3cret;');
  });

  it('reports variables that are missing or empty', () => {
    const result = interpolate('${PG_URL}${NOPE}${EMPTY}${NOPE}', env);
    expect(result.missing).toEqual(['NOPE', 'EMPTY']);
  });

  it('detects an invalid ${...} pattern', () => {
    expect(interpolate('${PG URL}', env).malformed).toBe(true);
    expect(interpolate('${PG_URL', env).malformed).toBe(true);
    expect(interpolate('no variables', env).malformed).toBe(false);
  });

  it('list of referenced variables', () => {
    expect(referencedVariables('a=${A};b=${B};c=${A}')).toEqual(['A', 'B']);
  });
});

describe('hasLiteralSecret', () => {
  it('safe: the whole url is one variable', () => {
    expect(hasLiteralSecret('${PROD_PG_URL}')).toBe(false);
    expect(hasLiteralSecret('  ${PROD_DB2_CONN}  ')).toBe(false);
  });

  it('safe: password through a variable', () => {
    expect(hasLiteralSecret('postgres://ro:${PG_PASS}@db.internal:5432/app')).toBe(false);
    expect(hasLiteralSecret('DATABASE=X;HOSTNAME=h;UID=ro;PWD=${DB2_PASS};')).toBe(false);
    expect(hasLiteralSecret('postgres://db/app?user=a&password=${P}')).toBe(false);
    // Regression: the keyword pattern must not read into a URL query string.
    expect(hasLiteralSecret('postgres://db/app?password=${P}&sslmode=require')).toBe(false);
  });

  it('safe: no password at all', () => {
    expect(hasLiteralSecret('postgres://ro@db.internal/app')).toBe(false);
    expect(hasLiteralSecret('DATABASE=X;HOSTNAME=h;UID=ro;')).toBe(false);
  });

  it('detected: a literal password in various forms', () => {
    expect(hasLiteralSecret('postgres://ro:hunter@db.internal/app')).toBe(true);
    expect(hasLiteralSecret('postgres://ro:p@ss@db.internal/app')).toBe(true);
    expect(hasLiteralSecret('DATABASE=X;HOSTNAME=h;UID=ro;PWD=hunter;')).toBe(true);
    expect(hasLiteralSecret('database=x;password = hunter')).toBe(true);
    expect(hasLiteralSecret('postgres://db/app?password=hunter')).toBe(true);
    expect(hasLiteralSecret('postgres://ro:pre${X}@db/app')).toBe(true);
  });
});
