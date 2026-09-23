import express, { type Router } from 'express';
import path from 'node:path';

export const WEB_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'";

function isReservedPath(requestPath: string): boolean {
  return requestPath === '/api' || requestPath.startsWith('/api/') || requestPath === '/admin' || requestPath.startsWith('/admin/');
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
    res.sendFile(indexFile);
  });

  return router;
}
