import { describe, expect, it } from 'vitest';
import { DEFAULT_MASK_COLUMNS } from '../../src/config/loader.js';
import { createColumnMatcher, maskResult, nameSegments } from '../../src/guard/masker.js';

describe('masker', () => {
  const sensitive = createColumnMatcher([...DEFAULT_MASK_COLUMNS, 'salary']);

  it('splits a column name per segment', () => {
    expect(nameSegments('customer_card_number')).toEqual(['customer', 'card', 'number']);
    expect(nameSegments('passwordHash')).toEqual(['password', 'hash']);
    expect(nameSegments('API-Key')).toEqual(['api', 'key']);
  });

  it('matches per segment, not per word fragment', () => {
    for (const column of [
      'password',
      'password_hash',
      'passwordHash',
      'nik',
      'no_nik',
      'NIK',
      'access_token',
      'card_number',
      'customer_card_number',
      'api_key',
      'salary_base',
    ]) {
      expect(sensitive(column)).toBe(true);
    }
    for (const column of [
      'technique',
      'unique',
      'clinic',
      'email',
      'tokenizer',
      'status',
      'number',
    ]) {
      expect(sensitive(column)).toBe(false);
    }
  });

  it('masks values, NULL stays NULL, the original result is not changed', () => {
    const original = {
      columns: ['id', 'password_hash', 'nik'],
      rows: [
        [1, 'hash-1', '3201'],
        [2, null, '3202'],
      ],
      truncated: false,
      durationMs: 1,
    };
    const { result, masked } = maskResult(original, sensitive);
    expect(masked).toEqual(['password_hash', 'nik']);
    expect(result.rows).toEqual([
      [1, '***', '***'],
      [2, null, '***'],
    ]);
    expect(original.rows[0]).toEqual([1, 'hash-1', '3201']);
  });

  it('without sensitive columns: the result object is returned as is', () => {
    const original = { columns: ['id'], rows: [[1]], truncated: false, durationMs: 1 };
    expect(maskResult(original, sensitive).result).toBe(original);
  });
});
