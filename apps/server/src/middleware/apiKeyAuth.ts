import type { RequestHandler } from 'express';
import { parsePresentedKey, verifySecret, DUMMY_SECRET_HASH, type MappingStore } from '@graphtorest/core';

export function createApiKeyAuth(mappingStore: MappingStore): RequestHandler {
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
      // Always pay for one scrypt so malformed keys, unknown ids and wrong secrets are indistinguishable by timing.
      const secretOk = await verifySecret(parsed?.secret ?? '', record?.hashedKey ?? DUMMY_SECRET_HASH);
      if (!parsed || !record || !secretOk) {
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
