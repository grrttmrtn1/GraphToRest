import { Router } from 'express';
import type { MappingStore } from '@graphtorest/core';

export function createAdminRouter(mappingStore: MappingStore): Router {
  const router = Router();

  router.post('/connections', (req, res) => {
    const { name, adapterType, authMode } = req.body ?? {};
    if (!name || !adapterType || !authMode) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name, adapterType, authMode required', details: {} } });
      return;
    }
    res.status(201).json(mappingStore.createConnection({ name, adapterType, authMode }));
  });

  router.get('/connections', (_req, res) => {
    res.json(mappingStore.listConnections());
  });

  router.post('/mappings', (req, res) => {
    const { connectionId, route, method, operation, responseTemplate, source } = req.body ?? {};
    if (!connectionId || !route || !method || !operation) {
      res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'connectionId, route, method, operation required', details: {} },
      });
      return;
    }
    res.status(201).json(
      mappingStore.createMapping({ connectionId, route, method, operation, responseTemplate, source })
    );
  });

  router.get('/mappings', (_req, res) => {
    res.json(mappingStore.listMappings());
  });

  router.post('/api-keys', (req, res) => {
    const { label } = req.body ?? {};
    const created = mappingStore.createApiKey({ label });
    res.status(201).json({ id: created.id, plaintext: created.plaintext, label: created.label });
  });

  return router;
}
