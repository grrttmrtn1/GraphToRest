import { Router } from 'express';
import { toErrorResponse, GatewayError, type GatewayEngine } from '@graphtorest/core';

export function createApiRouter(gatewayEngine: GatewayEngine): Router {
  const router = Router();
  router.use(async (req, res) => {
    try {
      const result = await gatewayEngine.handle(req.method, req.path);
      res.json(result);
    } catch (err) {
      if (!(err instanceof GatewayError)) console.error(err);
      const { status, body } = toErrorResponse(err);
      res.status(status).json(body);
    }
  });
  return router;
}
