import type { Request, RequestHandler } from 'express';
import type { MappingStore } from '@graphtorest/core';
import { ADMIN_SESSION_COOKIE, parseCookies } from './cookies';

export interface AdminAuthOptions {
  publicBaseUrl?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the admin session from `Authorization: Bearer` (CLI, scripts) or, when that header is absent, from the
 * HttpOnly session cookie (web UI). Cookie-authenticated state-changing requests must pass CSRF checks.
 */
export function createAdminAuth(store: MappingStore, options: AdminAuthOptions = {}): RequestHandler {
  return (req, res, next) => {
    const header = req.header('authorization');
    const viaCookie = header === undefined;
    const token = viaCookie ? parseCookies(req.header('cookie'))[ADMIN_SESSION_COOKIE] : /^Bearer (.+)$/.exec(header)?.[1];
    const session = token ? store.findAdminSessionDetails(token) : null;
    if (!token || !session) {
      res.locals.errorCode = 'UNAUTHORIZED';
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Admin login required', details: {} } });
      return;
    }
    if (viaCookie && !SAFE_METHODS.has(req.method)) {
      const rejection = csrfRejection(req, options.publicBaseUrl);
      if (rejection) {
        res.locals.errorCode = 'CSRF_REJECTED';
        res.status(403).json({ error: { code: 'CSRF_REJECTED', message: rejection, details: {} } });
        return;
      }
    }
    res.locals.adminUser = session.user;
    res.locals.adminToken = token;
    res.locals.adminSessionExpiresAt = session.expiresAt;
    res.locals.adminSessionViaCookie = viaCookie;
    next();
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Returns a rejection message, or null when the request is acceptable. */
function csrfRejection(req: Request, publicBaseUrl: string | undefined): string | null {
  const origin = req.header('origin');
  if (origin !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return 'Cross-site request rejected';
    }
    // Host alone is not an origin: accepting http://host for an https://host request would make the
    // schemeful same-origin check ineffective. req.protocol respects Express's configured trust-proxy policy.
    const requestOrigin = req.header('host') ? originOf(`${req.protocol}://${req.header('host')}`) : null;
    const matchesRequestOrigin = requestOrigin === parsed.origin;
    const matchesPublicBase = publicBaseUrl !== undefined && originOf(publicBaseUrl) === parsed.origin;
    if (!matchesRequestOrigin && !matchesPublicBase) return 'Cross-site request rejected';
  } else if (req.header('sec-fetch-site') !== 'same-origin') {
    return 'Cross-site request rejected';
  }
  const hasBody = Number(req.header('content-length') ?? 0) > 0 || req.header('transfer-encoding') !== undefined;
  if (hasBody && !/^application\/json\s*(;|$)/i.test(req.header('content-type') ?? '')) {
    return 'Admin requests with a body must be sent as application/json';
  }
  return null;
}
