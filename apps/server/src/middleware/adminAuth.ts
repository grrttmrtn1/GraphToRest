import type { RequestHandler } from 'express';
import type { MappingStore } from '@graphtorest/core';

export function createAdminAuth(store: MappingStore): RequestHandler {
  return (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    const user = match ? store.findAdminSession(match[1]) : null;
    if (!match || !user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Admin login required', details: {} } });
      return;
    }
    res.locals.adminUser = user;
    res.locals.adminToken = match[1];
    next();
  };
}
