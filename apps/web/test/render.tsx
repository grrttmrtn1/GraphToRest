import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { setUnauthorizedHandler } from '../src/api';
import { SESSION_KEY } from '../src/session';

export interface MockRoute {
  method?: string;
  path: string;
  status?: number;
  body?: unknown;
  text?: string;
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export const SESSION_ROUTE: MockRoute = { path: '/admin/session', body: { username: 'admin', expiresAt: '2099-01-01T00:00:00.000Z' } };

/** Stubs global fetch. The first route matching method + exact path (including query) wins; unmatched calls get a 404 envelope. */
export function mockFetch(routes: MockRoute[]) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({
      method,
      path: url,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const route = routes.find((r) => (r.method ?? 'GET') === method && r.path === url);
    if (!route) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `No mock for ${method} ${url}`, details: {} } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const status = route.status ?? 200;
    if (status === 204) return new Response(null, { status });
    if (route.text !== undefined) return new Response(route.text, { status, headers: { 'Content-Type': 'text/yaml' } });
    return new Response(JSON.stringify(route.body ?? null), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export function renderApp(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  setUnauthorizedHandler(() => queryClient.setQueryData(SESSION_KEY, null));
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...utils, queryClient };
}
