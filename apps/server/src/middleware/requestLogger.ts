import type { RequestHandler } from 'express';
import type { Logger } from '@graphtorest/core';

/**
 * Emits one `request_completed` line when the response finishes. Only the path is logged — never the query string,
 * headers or body. /api lines carry gateway fields; /admin lines carry the admin user id.
 */
export function createRequestLogger(logger: Logger, kind: 'api' | 'admin'): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const locals = res.locals;
      const base = {
        kind,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
        errorCode: (locals.errorCode as string | undefined) ?? null,
      };
      const fields =
        kind === 'api'
          ? {
              ...base,
              apiKeyId: locals.apiKeyId ?? null,
              connectionId: locals.connectionId ?? null,
              mappingId: locals.mappingId ?? null,
              cache: locals.cache ?? null,
              vendorLatencyMs: locals.vendorLatencyMs ?? null,
            }
          : { ...base, adminUserId: (locals.adminUser as { id?: string } | undefined)?.id ?? null };
      logger.info('request_completed', fields);
    });
    next();
  };
}
