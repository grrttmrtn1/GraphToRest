import { Router } from 'express';
import { toErrorResponse, type GatewayEngine } from '@graphtorest/core';

export function createApiRouter(gatewayEngine: GatewayEngine): Router {
  const router = Router();
  router.use(async (req, res) => {
    try {
      const result = await gatewayEngine.handle(req.method, req.path);
      res.json(result);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      res.status(status).json(body);
    }
  });
  return router;
}
