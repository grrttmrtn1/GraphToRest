import type { Logger } from '@graphtorest/core';

export interface ClosableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

export interface ShutdownOptions {
  server: ClosableServer;
  cleanup: () => void;
  logger: Logger;
  timeoutMs?: number;
  exit?: (code: number) => void;
}

/** Stop accepting connections, let in-flight requests finish (up to timeoutMs), then clean up and exit. Idempotent. */
export function createShutdown(options: ShutdownOptions): (signal: string) => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? 10_000;
  let started = false;
  let finished = false;

  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    let exitCode = code;
    try {
      options.cleanup();
    } catch (err) {
      options.logger.error('shutdown_cleanup_failed', { error: err });
      exitCode = 1;
    }
    options.logger.info('shutdown_complete', { exitCode });
    exit(exitCode);
  };

  return (signal: string) => {
    if (started) return;
    started = true;
    options.logger.info('shutdown_started', { signal });
    const timer = setTimeout(() => {
      options.logger.warn('shutdown_timeout', { timeoutMs });
      options.server.closeAllConnections();
      finish(1);
    }, timeoutMs);
    options.server.close(() => {
      clearTimeout(timer);
      finish(0);
    });
    options.server.closeIdleConnections();
  };
}

export function installShutdownHandlers(shutdown: (signal: string) => void, proc: Pick<NodeJS.Process, 'on'> = process): void {
  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('SIGINT', () => shutdown('SIGINT'));
}
