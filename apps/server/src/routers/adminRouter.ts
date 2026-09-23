import { Router } from 'express';
import {
  type MappingStore,
  type ManagedTokenService,
  type ConnectionRecord,
  buildAuthContext,
  generateAndPersistMappings,
  parseMappingFields,
  loginAdmin,
  toErrorResponse,
  GatewayError,
} from '@graphtorest/core';
import { createAdminAuth } from '../middleware/adminAuth';
import { parseCookies, sessionCookie, ADMIN_SESSION_COOKIE } from '../middleware/cookies';

export interface AdminRouterOptions {
  sessionTtlMs?: number;
  managedAuth?: ManagedTokenService;
  publicBaseUrl?: string;
}

export function createAdminRouter(mappingStore: MappingStore, options: AdminRouterOptions = {}): Router {
  const router = Router();
  const requireAdmin = createAdminAuth(mappingStore, { publicBaseUrl: options.publicBaseUrl });
  const secureCookies = (options.publicBaseUrl ?? '').startsWith('https://');

  const requireManagedAuth = (): ManagedTokenService => {
    if (!options.managedAuth) {
      throw new GatewayError('MANAGED_AUTH_DISABLED', 'Managed auth is disabled: set CREDENTIAL_ENCRYPTION_KEY on the server', 503);
    }
    return options.managedAuth;
  };

  const findManagedConnection = (id: string): ConnectionRecord => {
    const connection = mappingStore.getConnection(id);
    if (!connection) throw new GatewayError('NOT_FOUND', 'Connection not found', 404);
    if (connection.authMode !== 'managed') {
      throw new GatewayError('INVALID_INPUT', 'The connection authMode must be "managed" to use stored credentials', 400);
    }
    return connection;
  };

  router.post('/login', (req, res) => {
    const { username, password, session } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'username and password required', details: {} } });
      return;
    }
    if (session !== undefined && session !== 'cookie') {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: '"session" must be "cookie" when provided', details: {} } });
      return;
    }
    const result = loginAdmin(mappingStore, username, password, options.sessionTtlMs);
    if (!result) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid username or password', details: {} } });
      return;
    }
    if (session !== 'cookie') {
      res.json(result);
      return;
    }
    const details = mappingStore.findAdminSessionDetails(result.token);
    res.setHeader(
      'Set-Cookie',
      sessionCookie(result.token, { maxAgeSeconds: (Date.parse(result.expiresAt) - Date.now()) / 1000, secure: secureCookies })
    );
    // The token travels only in the HttpOnly cookie, never in a body page scripts could read.
    res.json({ username: details?.user.username ?? username, expiresAt: result.expiresAt });
  });

  router.get('/oauth/callback', async (req, res) => {
    try {
      const managedAuth = requireManagedAuth();
      const { code, state, error } = req.query;
      if (typeof error === 'string') {
        throw new GatewayError('AUTHORIZATION_DENIED', `The vendor reported an authorization error: ${error.slice(0, 100)}`, 400);
      }
      if (typeof code !== 'string' || typeof state !== 'string') {
        throw new GatewayError('INVALID_INPUT', '"code" and "state" query parameters are required', 400);
      }
      const { connectionId } = await managedAuth.completeAuthorization(state, code);
      res.json({ status: 'authorized', connectionId });
    } catch (err) {
      if (!(err instanceof GatewayError)) console.error(err);
      const { status, body } = toErrorResponse(err);
      res.status(status).json(body);
    }
  });

  // Everything below this line requires an admin session.
  router.use(requireAdmin);

  router.get('/session', (_req, res) => {
    res.json({ username: res.locals.adminUser.username as string, expiresAt: res.locals.adminSessionExpiresAt as string });
  });

  router.post('/logout', (req, res) => {
    mappingStore.deleteAdminSession(res.locals.adminToken as string);
    if (parseCookies(req.header('cookie'))[ADMIN_SESSION_COOKIE] !== undefined) {
      res.setHeader('Set-Cookie', sessionCookie('', { maxAgeSeconds: 0, secure: secureCookies }));
    }
    res.status(204).end();
  });

  router.post('/admin-users', (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'username and password required', details: {} } });
      return;
    }
    try {
      res.status(201).json(mappingStore.createAdminUser({ username, password }));
    } catch (err) {
      if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({
          error: { code: 'CONFLICT', message: 'An admin user with this username already exists', details: {} },
        });
        return;
      }
      throw err;
    }
  });

  router.put('/connections/:id/credentials', (req, res) => {
    const managedAuth = requireManagedAuth();
    const connection = findManagedConnection(req.params.id);
    res.json(managedAuth.saveCredentials(connection, req.body));
  });

  router.get('/connections/:id/credentials', (req, res) => {
    const managedAuth = requireManagedAuth();
    const connection = findManagedConnection(req.params.id);
    res.json(managedAuth.getCredentialStatus(connection.id));
  });

  router.post('/connections/:id/oauth/start', (req, res) => {
    const managedAuth = requireManagedAuth();
    const connection = findManagedConnection(req.params.id);
    // Never derive the redirect URI from the client-controlled Host header.
    if (!options.publicBaseUrl) {
      throw new GatewayError('INVALID_CONFIGURATION', 'PUBLIC_BASE_URL must be configured to start an OAuth authorization', 503);
    }
    const baseUrl = options.publicBaseUrl.replace(/\/+$/, '');
    res.json({ authorizationUrl: managedAuth.beginAuthorization(connection, `${baseUrl}/admin/oauth/callback`) });
  });

  router.post('/connections', (req, res) => {
    const { name, adapterType, authMode, config } = req.body ?? {};
    if (!name || !adapterType || !authMode) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name, adapterType, authMode required', details: {} } });
      return;
    }
    try {
      res.status(201).json(mappingStore.createConnection({ name, adapterType, authMode, config }));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({
          error: { code: 'CONFLICT', message: 'A connection with this name already exists', details: {} },
        });
        return;
      }
      throw err;
    }
  });

  router.get('/connections', (_req, res) => {
    res.json(mappingStore.listConnections());
  });

  router.post('/connections/:id/mappings/generate', async (req, res) => {
    const connection = mappingStore.getConnection(req.params.id);
    if (!connection) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Connection not found', details: {} } });
      return;
    }
    const force = (req.body ?? {}).force === true;
    const vendorToken = req.header('x-vendor-token') ?? undefined;
    try {
      const authContext = await buildAuthContext(connection, vendorToken, options.managedAuth);
      const result = await generateAndPersistMappings(mappingStore, connection, authContext, { force });
      res.json(result);
    } catch (err) {
      if (!(err instanceof GatewayError)) console.error(err);
      const { status, body } = toErrorResponse(err);
      res.status(status).json(body);
    }
  });

  router.post('/mappings', (req, res) => {
    const { connectionId, route, method, operation, responseTemplate, source } = req.body ?? {};
    if (!connectionId || !route || !method || !operation) {
      res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'connectionId, route, method, operation required', details: {} },
      });
      return;
    }
    const fields = parseMappingFields({ route, method, operation, responseTemplate, source });
    try {
      res.status(201).json(
        mappingStore.createMapping({
          connectionId,
          route: fields.route as string,
          method: fields.method as string,
          operation: fields.operation as Record<string, unknown>,
          responseTemplate: fields.responseTemplate,
          source: fields.source,
        })
      );
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({
          error: { code: 'CONFLICT', message: 'A mapping with this route and method already exists', details: {} },
        });
        return;
      }
      if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        res.status(400).json({
          error: { code: 'INVALID_INPUT', message: 'connectionId does not reference an existing connection', details: {} },
        });
        return;
      }
      throw err;
    }
  });

  router.get('/mappings', (_req, res) => {
    res.json(mappingStore.listMappings());
  });

  router.patch('/mappings/:id', (req, res) => {
    const fields = parseMappingFields(req.body ?? {});
    if (
      fields.route === undefined &&
      fields.method === undefined &&
      fields.operation === undefined &&
      fields.responseTemplate === undefined
    ) {
      throw new GatewayError('INVALID_INPUT', 'At least one of route, method, operation, responseTemplate is required', 400);
    }
    try {
      const updated = mappingStore.updateMapping(req.params.id, {
        route: fields.route,
        method: fields.method,
        operation: fields.operation,
        responseTemplate: fields.responseTemplate,
        source: 'manual', // any admin edit flips a mapping to manual (spec §5.2); a body "source" is ignored
      });
      if (!updated) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mapping not found', details: {} } });
        return;
      }
      res.json(updated);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({
          error: { code: 'CONFLICT', message: 'A mapping with this route and method already exists', details: {} },
        });
        return;
      }
      throw err;
    }
  });

  router.post('/api-keys', (req, res) => {
    const { label } = req.body ?? {};
    const created = mappingStore.createApiKey({ label });
    res.status(201).json({ id: created.id, plaintext: created.plaintext, label: created.label });
  });

  return router;
}
