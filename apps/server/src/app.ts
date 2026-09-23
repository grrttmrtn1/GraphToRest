import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { toErrorResponse, GatewayError, type MappingStore, type GatewayEngine, type OpenApiGenerator, type ManagedTokenService } from '@graphtorest/core';
import { createApiKeyAuth } from './middleware/apiKeyAuth';
import { createActivityLogger, DEFAULT_ACTIVITY_RETENTION } from './middleware/activityLog';
import { createApiRouter } from './routers/apiRouter';
import { createAdminRouter } from './routers/adminRouter';
import { createWebHandler } from './web';

export interface AppDeps {
  mappingStore: MappingStore;
  gatewayEngine: GatewayEngine;
  openApiGenerator: OpenApiGenerator;
  apiEnabled: boolean;
  adminEnabled: boolean;
  adminSessionTtlMs?: number;
  managedAuth?: ManagedTokenService;
  publicBaseUrl?: string;
  activityRetention?: number;
  webRoot?: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  // 1 MB so the web UI can import a mappings YAML file through POST /admin/mappings/import.
  app.use(express.json({ limit: '1mb' }));

  if (deps.apiEnabled) {
    app.get('/api/openapi.json', (_req, res) => {
      res.json(deps.openApiGenerator.generate(deps.mappingStore.listMappings()));
    });
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(null, { swaggerOptions: { url: '/api/openapi.json' } }));
    app.use(
      '/api',
      createActivityLogger(deps.mappingStore, deps.activityRetention ?? DEFAULT_ACTIVITY_RETENTION),
      createApiKeyAuth(deps.mappingStore),
      createApiRouter(deps.gatewayEngine)
    );
  }

  if (deps.adminEnabled) {
    app.use(
      '/admin',
      createAdminRouter(deps.mappingStore, {
        sessionTtlMs: deps.adminSessionTtlMs,
        managedAuth: deps.managedAuth,
        publicBaseUrl: deps.publicBaseUrl,
        webUiRedirects: deps.webRoot !== undefined,
      })
    );
  }

  if (deps.webRoot) {
    app.use(createWebHandler(deps.webRoot));
  }

  // A plain 404 for anything unmatched above (e.g. `/` with no webRoot configured), so Express's default
  // finalhandler page — which sets its own Content-Security-Policy header — never answers a request.
  app.use((_req, res) => {
    res.status(404).end();
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof GatewayError) {
      const { status: gatewayStatus, body } = toErrorResponse(err);
      res.status(gatewayStatus).json(body);
      return;
    }
    const status = (err as { status?: unknown })?.status;
    if (typeof status === 'number' && status < 500) {
      const message = (err as { message?: unknown })?.message;
      res.status(status).json({
        error: {
          code: 'INVALID_REQUEST',
          message: typeof message === 'string' && message.length > 0 ? message : 'Invalid request',
          details: {},
        },
      });
      return;
    }
    console.error(err);
    const { status: normalizedStatus, body } = toErrorResponse(err);
    res.status(normalizedStatus).json(body);
  });

  return app;
}
