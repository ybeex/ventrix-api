import { stringify } from 'csv-stringify';
import { Readable } from 'node:stream';

/**
 * CSV formula-injection defence: a cell that starts with = + - @ (or tab/CR) is executed as a formula by Excel/Sheets.
 * Item names, notes and holder names are user-controlled, so every text cell is neutralised with a leading apostrophe.
 * Numeric cells are untouched (a negative variance must stay a number).
 */
export const safeCell = (v: unknown): unknown => {
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) return `'${v}`;
  return v;
};

export function csvStream(columns: Array<{ key: string; label: string }>, pages: AsyncGenerator<Array<Record<string, unknown>>>): Readable {
  const out = stringify({ header: true, columns: columns.map((c) => ({ key: c.key, header: c.label })), cast: { string: (v) => String(safeCell(v)) } });
  (async () => {
    try {
      for await (const page of pages) for (const row of page) if (!out.write(row)) await new Promise((r) => out.once('drain', r));
      out.end();
    } catch (err) { out.destroy(err as Error); }
  })();
  return out;
}
