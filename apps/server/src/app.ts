import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { MappingStore, GatewayEngine, OpenApiGenerator } from '@graphtorest/core';
import { createApiKeyAuth } from './middleware/apiKeyAuth';
import { createApiRouter } from './routers/apiRouter';
import { createAdminRouter } from './routers/adminRouter';

export interface AppDeps {
  mappingStore: MappingStore;
  gatewayEngine: GatewayEngine;
  openApiGenerator: OpenApiGenerator;
  apiEnabled: boolean;
  adminEnabled: boolean;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());

  if (deps.apiEnabled) {
    app.get('/api/openapi.json', (_req, res) => {
      res.json(deps.openApiGenerator.generate(deps.mappingStore.listMappings()));
    });
    app.use(
      '/api/docs',
      swaggerUi.serve,
      swaggerUi.setup(deps.openApiGenerator.generate(deps.mappingStore.listMappings()))
    );
    app.use('/api', createApiKeyAuth(deps.mappingStore), createApiRouter(deps.gatewayEngine));
  }

  if (deps.adminEnabled) {
    app.use('/admin', createAdminRouter(deps.mappingStore));
  }

  return app;
}
