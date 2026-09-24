import type { RequestHandler } from 'express';
import { silentLogger, type Logger, type MappingStore } from '@graphtorest/core';

export const DEFAULT_ACTIVITY_RETENTION = 1000;

/**
 * Writes one request_log row per /api request when the response finishes. Only the path is stored — never the
 * query string, headers or body. A failed write is logged and never affects the response.
 */
export function createActivityLogger(store: MappingStore, retention: number, logger: Logger = silentLogger): RequestHandler {
  return (req, res, next) => {
    const startedAt = new Date();
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      try {
        store.recordRequest(
          {
            ts: startedAt.toISOString(),
            method: req.method,
            path: req.originalUrl.split('?')[0],
            status: res.statusCode,
            durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
            errorCode: (res.locals.errorCode as string | undefined) ?? null,
            apiKeyId: (res.locals.apiKeyId as string | undefined) ?? null,
            connectionId: (res.locals.connectionId as string | undefined) ?? null,
            mappingId: (res.locals.mappingId as string | undefined) ?? null,
          },
          retention
        );
      } catch (err) {
        logger.error('activity_log_write_failed', { error: err });
      }
    });
    next();
  };
}
