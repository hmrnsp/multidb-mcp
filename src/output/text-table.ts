/**
 * Compact text table for Claude to read: rows separated by "|", with no padding to
 * save tokens. Used by list_databases and by query results.
 */

export interface TableOptions {
  /** Maximum length of one cell before it is cut. Default 200. */
  maxCellChars?: number;
}

const DEFAULT_MAX_CELL = 200;

/** Format a byte count for humans, e.g. "1.2 KB". */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Turn one value into single-line text that is safe inside a table. */
export function formatCell(value: unknown, maxCellChars = DEFAULT_MAX_CELL): string {
  let text: string;
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `<binary ${formatBytes(value.byteLength)}>`;
  }
  if (value instanceof Date) {
    text = Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  } else if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value) ?? '[object cannot be displayed]';
    } catch {
      text = '[object cannot be displayed]';
    }
  }

  const singleLine = text
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, ' ')
    .replace(/\|/g, '\\|');
  if (singleLine.length <= maxCellChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxCellChars - 1))}…`;
}

/** Render rows as a compact text table: header, separator, and "|"-separated rows. */
export function renderTable(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  options: TableOptions = {},
): string {
  const max = options.maxCellChars ?? DEFAULT_MAX_CELL;
  const header = columns.map((c) => formatCell(c, max)).join(' | ');
  const divider = columns.map(() => '---').join(' | ');
  const body = rows.map((row) => columns.map((_, i) => formatCell(row[i], max)).join(' | '));
  return [header, divider, ...body].join('\n');
}
