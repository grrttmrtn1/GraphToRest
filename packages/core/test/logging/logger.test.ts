import { describe, it, expect } from 'vitest';
import { createLogger, silentLogger } from '../../src/logging/logger';

function capture(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const logger = createLogger({
    level,
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    write: (line, lvl) => lines.push({ level: lvl, entry: JSON.parse(line) }),
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes one JSON object per call with ts, level and msg first', () => {
    const { logger, lines } = capture();
    logger.info('server_started', { port: 3000 });
    expect(lines).toEqual([{ level: 'info', entry: { ts: '2026-09-24T12:00:00.000Z', level: 'info', msg: 'server_started', port: 3000 } }]);
  });

  it('filters below the configured level (default info)', () => {
    const { logger, lines } = capture();
    logger.debug('noise');
    logger.warn('kept');
    expect(lines.map((l) => l.entry.msg)).toEqual(['kept']);
    const verbose = capture('debug');
    verbose.logger.debug('shown');
    expect(verbose.lines).toHaveLength(1);
  });

  it('serializes Error values with name, message and stack', () => {
    const { logger, lines } = capture();
    logger.error('unhandled_error', { error: new TypeError('boom') });
    const error = lines[0].entry.error as Record<string, unknown>;
    expect(error.name).toBe('TypeError');
    expect(error.message).toBe('boom');
    expect(typeof error.stack).toBe('string');
  });

  it('cannot be overridden by fields named ts/level/msg', () => {
    const { logger, lines } = capture();
    logger.info('real', { msg: 'fake', level: 'error', ts: 'x' });
    expect(lines[0].entry).toMatchObject({ msg: 'real', level: 'info', ts: '2026-09-24T12:00:00.000Z' });
  });

  it('silentLogger discards everything', () => {
    expect(() => silentLogger.error('x', { a: 1 })).not.toThrow();
  });
});
