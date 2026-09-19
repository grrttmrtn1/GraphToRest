import { Router } from 'express';
import { type MappingStore, generateAndPersistMappings, toErrorResponse, GatewayError } from '@graphtorest/core';

export function createAdminRouter(mappingStore: MappingStore): Router {
  const router = Router();

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
      const result = await generateAndPersistMappings(
        mappingStore,
        connection,
        { connectionId: connection.id, authMode: connection.authMode, config: connection.config, vendorToken },
        { force }
      );
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
    try {
      res.status(201).json(
        mappingStore.createMapping({ connectionId, route, method, operation, responseTemplate, source })
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
    const { route, method, operation, responseTemplate } = req.body ?? {};
    try {
      const updated = mappingStore.updateMapping(req.params.id, { route, method, operation, responseTemplate, source: 'manual' });
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
