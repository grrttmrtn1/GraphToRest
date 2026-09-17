import type { RequestHandler } from 'express';
import { parsePresentedKey, verifySecret, type MappingStore } from '@graphtorest/core';

export function createApiKeyAuth(mappingStore: MappingStore): RequestHandler {
  return (req, res, next) => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing API key', details: {} } });
      return;
    }
    const parsed = parsePresentedKey(match[1]);
    const record = parsed ? mappingStore.findApiKeyById(parsed.id) : null;
    if (!parsed || !record || !verifySecret(parsed.secret, record.hashedKey)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key', details: {} } });
      return;
    }
    mappingStore.touchApiKeyLastUsed(record.id);
    next();
  };
}
