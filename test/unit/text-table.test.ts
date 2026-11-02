import { describe, expect, it } from 'vitest';
import { formatBytes, formatCell, renderTable } from '../../src/output/text-table.js';

describe('formatCell', () => {
  it('basic values', () => {
    expect(formatCell(null)).toBe('NULL');
    expect(formatCell(undefined)).toBe('NULL');
    expect(formatCell(42)).toBe('42');
    expect(formatCell(9007199254740993n)).toBe('9007199254740993');
    expect(formatCell(true)).toBe('true');
    expect(formatCell(new Date('2026-01-15T10:30:00Z'))).toBe('2026-01-15T10:30:00.000Z');
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });

  it('binary is shown as a size, not its content', () => {
    expect(formatCell(Buffer.alloc(1_230))).toBe('<binary 1.2 KB>');
    expect(formatCell(new Uint8Array(10))).toBe('<binary 10 B>');
  });

  it('one line: newline, tab, and column separator are escaped', () => {
    expect(formatCell('a\nb\r\nc\td|e')).toBe('a\\nb\\nc d\\|e');
  });

  it('long text is cut with the … mark', () => {
    const out = formatCell('x'.repeat(300));
    expect(out).toHaveLength(200);
    expect(out.endsWith('…')).toBe(true);
    expect(formatCell('abcdef', 4)).toBe('abc…');
  });

  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

describe('renderTable', () => {
  it('header, separator, and rows', () => {
    expect(
      renderTable(
        ['id', 'name'],
        [
          [1, 'Alice'],
          [2, null],
        ],
      ),
    ).toBe('id | name\n--- | ---\n1 | Alice\n2 | NULL');
  });

  it('a row shorter than the number of columns is padded with NULL', () => {
    expect(renderTable(['a', 'b'], [[1]])).toBe('a | b\n--- | ---\n1 | NULL');
  });
});
