import { Router } from 'express';
import { toErrorResponse, GatewayError, type GatewayEngine } from '@graphtorest/core';

export function createApiRouter(gatewayEngine: GatewayEngine): Router {
  const router = Router();
  router.use(async (req, res) => {
    try {
      const vendorToken = req.header('x-vendor-token') ?? undefined;
      const result = await gatewayEngine.handle(
        req.method,
        req.path,
        { vendorToken },
        { query: req.query as Record<string, string>, body: req.body },
        {
          onMatch: (mapping) => {
            res.locals.connectionId = mapping.connectionId;
            res.locals.mappingId = mapping.id;
          },
        }
      );
      res.json(result);
    } catch (err) {
      if (!(err instanceof GatewayError)) console.error(err);
      const { status, body } = toErrorResponse(err);
      res.locals.errorCode = body.error.code;
      res.status(status).json(body);
    }
  });
  return router;
}
