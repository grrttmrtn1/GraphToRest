import type { RequestHandler } from 'express';
import { parsePresentedKey, verifySecret, DUMMY_SECRET_HASH, type MappingStore } from '@graphtorest/core';
import type { ApiAuthThrottle } from './apiAuthThrottle';

export function createApiKeyAuth(mappingStore: MappingStore, throttle?: ApiAuthThrottle): RequestHandler {
  return async (req, res, next) => {
    try {
      const header = req.header('authorization') ?? '';
      const match = /^Bearer (.+)$/.exec(header);
      if (!match) {
        res.locals.errorCode = 'UNAUTHORIZED';
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing API key', details: {} } });
        return;
      }
      const parsed = parsePresentedKey(match[1]);
      const record = parsed ? mappingStore.findApiKeyById(parsed.id) : null;
      // An address that has spent its failure budget is refused before the scrypt, but only for keys that cannot be
      // valid (malformed or unknown id) — a real key id always goes on to verification. See ApiAuthThrottle.
      const retryMs = !record && throttle ? throttle.retryAfterMs(req.ip) : 0;
      if (retryMs > 0) {
        const retryAfterSeconds = Math.max(1, Math.ceil(retryMs / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.locals.errorCode = 'AUTH_THROTTLED';
        res.status(429).json({ error: { code: 'AUTH_THROTTLED', message: 'Too many failed API key attempts; try again later', details: { retryAfterSeconds } } });
        return;
      }
      // Always pay for one scrypt so malformed keys, unknown ids and wrong secrets are indistinguishable by timing.
      const secretOk = await verifySecret(parsed?.secret ?? '', record?.hashedKey ?? DUMMY_SECRET_HASH);
      if (!parsed || !record || !secretOk) {
        throttle?.recordFailure(req.ip);
        res.locals.errorCode = 'UNAUTHORIZED';
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key', details: {} } });
        return;
      }
      mappingStore.touchApiKeyLastUsed(record.id);
      res.locals.apiKeyId = record.id;
      res.locals.apiKeyRateLimit = record.rateLimit;
      next();
    } catch (err) {
      next(err);
    }
  };
}
