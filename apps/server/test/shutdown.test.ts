import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { silentLogger } from '@graphtorest/core';
import { createShutdown, installShutdownHandlers } from '../src/shutdown';

function fakeServer() {
  let onClosed: (() => void) | undefined;
  return {
    close: vi.fn((cb?: () => void) => { onClosed = cb; }),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
    drained: () => onClosed?.(),
  };
}

afterEach(() => vi.useRealTimers());

describe('graceful shutdown', () => {
  it('stops accepting, drains, cleans up once and exits 0', () => {
    const server = fakeServer();
    const cleanup = vi.fn();
    const exit = vi.fn();
    const shutdown = createShutdown({ server, cleanup, logger: silentLogger, exit });
    shutdown('SIGTERM');
    shutdown('SIGINT'); // ignored
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    server.drained();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forces connections closed and exits 1 after the timeout', () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const cleanup = vi.fn();
    const exit = vi.fn();
    createShutdown({ server, cleanup, logger: silentLogger, exit, timeoutMs: 10_000 })('SIGTERM');
    vi.advanceTimersByTime(10_000);
    expect(server.closeAllConnections).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    server.drained(); // a late close callback must not clean up or exit twice
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('wires SIGTERM and SIGINT', () => {
    const proc = new EventEmitter();
    const shutdown = vi.fn();
    installShutdownHandlers(shutdown, proc as unknown as Pick<NodeJS.Process, 'on'>);
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    expect(shutdown.mock.calls).toEqual([['SIGTERM'], ['SIGINT']]);
  });
});
