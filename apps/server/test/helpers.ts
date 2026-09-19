import request from 'supertest';
import type { Express } from 'express';
import type { MappingStore } from '@graphtorest/core';

export const TEST_ADMIN_PASSWORD = 'correct-horse-battery';

/** Seeds an admin user + session and returns a supertest wrapper that sends the admin bearer token on every call. */
export function createAdminClient(app: Express, store: MappingStore) {
  const user = store.createAdminUser({ username: 'test-admin', password: TEST_ADMIN_PASSWORD });
  const { token } = store.createAdminSession(user.id, 60 * 60 * 1000);
  const authed = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  return {
    token,
    get: (url: string) => authed(request(app).get(url)),
    post: (url: string) => authed(request(app).post(url)),
    put: (url: string) => authed(request(app).put(url)),
    patch: (url: string) => authed(request(app).patch(url)),
    delete: (url: string) => authed(request(app).delete(url)),
  };
}

export type AdminClient = ReturnType<typeof createAdminClient>;
