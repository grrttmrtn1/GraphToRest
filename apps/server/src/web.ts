import express, { type Router } from 'express';
import path from 'node:path';

export const WEB_CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

function isReservedPath(requestPath: string): boolean {
  return requestPath === '/api' || requestPath.startsWith('/api/') || requestPath === '/admin' || requestPath.startsWith('/admin/');
}

/**
 * True for a request path that should 404 instead of falling back to index.html when no static file matches:
 * anything under /assets/ (the hashed build output), or a single path segment with a file extension
 * (e.g. /favicon.ico, /foo.js). Client routes such as /connections/<id> are never single-segment-with-extension
 * checked beyond that: only the single-segment case is restricted this way, so an id containing a dot (none do
 * today — connection ids are crypto.randomUUID()) can never be mistaken for a missing asset.
 */
function isMissingAssetPath(requestPath: string): boolean {
  if (requestPath.startsWith('/assets/')) return true;
  const segments = requestPath.split('/').filter(Boolean);
  if (segments.length !== 1) return false;
  const dotIndex = segments[0].lastIndexOf('.');
  return dotIndex > 0 && dotIndex < segments[0].length - 1;
}

/** Serves the built SPA from `webRoot`, falling back to index.html for client routes. Never answers /api or /admin paths. */
export function createWebHandler(webRoot: string): Router {
  const router = express.Router();
  const serveStatic = express.static(webRoot, { index: 'index.html' });
  const indexFile = path.join(webRoot, 'index.html');

  router.use((req, res, next) => {
    if (isReservedPath(req.path)) {
      next();
      return;
    }
    res.setHeader('Content-Security-Policy', WEB_CSP);
    serveStatic(req, res, next);
  });

  router.get('*', (req, res, next) => {
    if (isReservedPath(req.path)) {
      next();
      return;
    }
    if (isMissingAssetPath(req.path)) {
      res.status(404).end();
      return;
    }
    res.sendFile(indexFile);
  });

  return router;
}
