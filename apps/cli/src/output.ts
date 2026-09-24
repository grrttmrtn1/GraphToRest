export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** Table/summary text by default; raw JSON with --json. Warnings and prompts never go to stdout. */
export class Output {
  constructor(
    private readonly io: Io,
    readonly json: boolean
  ) {}

  result<T>(value: T, render: (value: T) => string): void {
    this.io.out(`${this.json ? JSON.stringify(value, null, 2) : render(value)}\n`);
  }

  /** For commands with no result body (delete, revoke, logout). */
  done(message: string): void {
    this.io.out(this.json ? `${JSON.stringify({ ok: true })}\n` : `${message}\n`);
  }

  /** Content printed verbatim in both modes (YAML export). */
  raw(text: string): void {
    this.io.out(text.endsWith('\n') ? text : `${text}\n`);
  }

  warn(message: string): void {
    this.io.err(`${message}\n`);
  }
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ');
  return [line(headers), ...rows.map(line)].join('\n');
}
