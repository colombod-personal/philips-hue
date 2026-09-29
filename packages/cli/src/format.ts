/** Output helpers: JSON for agents, aligned tables for humans. Streams are injectable for tests. */

export interface OutputStreams {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

let streams: OutputStreams = { stdout: process.stdout, stderr: process.stderr };

export function setOutput(next: Partial<OutputStreams>): void {
  streams = { stdout: next.stdout ?? process.stdout, stderr: next.stderr ?? process.stderr };
}

export function writeOut(text: string): void {
  streams.stdout.write(text);
}

export function writeErr(text: string): void {
  streams.stderr.write(text);
}

export function printJson(value: unknown): void {
  writeOut(JSON.stringify(value, null, 2) + '\n');
}

export function printTable(rows: Array<Record<string, unknown>>, columns?: string[]): void {
  if (rows.length === 0) {
    writeOut('(none)\n');
    return;
  }
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown): string => (v === null || v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (values: string[]) => values.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ').trimEnd() + '\n';
  writeOut(line(cols.map((c) => c.toUpperCase())));
  for (const r of rows) writeOut(line(cols.map((c) => cell(r[c]))));
}

export function formatValue(value: unknown, unit: string): string {
  if (value === null || value === undefined) return '-';
  if (unit === 'boolean') return value ? 'yes' : 'no';
  if (unit === '°C' || unit === 'lux' || unit === '%') return `${value} ${unit}`;
  return String(value);
}
