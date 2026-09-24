import { describe, it, expect } from 'vitest';
import { Output, table, type Io } from '../src/output';

function capture(): Io & { stdout: string; stderr: string } {
  const io = { stdout: '', stderr: '', out: (t: string) => { io.stdout += t; }, err: (t: string) => { io.stderr += t; } };
  return io;
}

describe('table', () => {
  it('aligns columns with two spaces and no trailing whitespace', () => {
    expect(table(['ID', 'NAME'], [['1', 'alpha'], ['22', 'b']])).toBe('ID  NAME\n1   alpha\n22  b');
  });

  it('renders only the header for no rows', () => {
    expect(table(['ID', 'NAME'], [])).toBe('ID  NAME');
  });
});

describe('Output', () => {
  it('renders with the renderer in table mode', () => {
    const io = capture();
    new Output(io, false).result({ n: 1 }, (v) => `n is ${v.n}`);
    expect(io.stdout).toBe('n is 1\n');
  });

  it('prints pretty JSON in json mode and ignores the renderer', () => {
    const io = capture();
    new Output(io, true).result({ n: 1 }, () => 'unused');
    expect(JSON.parse(io.stdout)).toEqual({ n: 1 });
  });

  it('done prints the message, or {"ok":true} in json mode', () => {
    const plain = capture();
    new Output(plain, false).done('Deleted mapping m1.');
    expect(plain.stdout).toBe('Deleted mapping m1.\n');
    const json = capture();
    new Output(json, true).done('Deleted mapping m1.');
    expect(JSON.parse(json.stdout)).toEqual({ ok: true });
  });

  it('raw prints text as-is with exactly one trailing newline in both modes', () => {
    const io = capture();
    new Output(io, true).raw('- a: 1\n');
    new Output(io, true).raw('- b: 2');
    expect(io.stdout).toBe('- a: 1\n- b: 2\n');
  });

  it('warn always goes to stderr', () => {
    const io = capture();
    new Output(io, true).warn('careful');
    expect(io.stdout).toBe('');
    expect(io.stderr).toBe('careful\n');
  });
});
