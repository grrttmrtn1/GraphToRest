import { describe, it, expect, afterEach, vi } from 'vitest';
import { apiFetch, ApiError, setUnauthorizedHandler } from '../src/api';
import { mockFetch } from './render';

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(() => {});
});

describe('apiFetch', () => {
  it('sends JSON bodies with the session cookie and parses JSON responses', async () => {
    const { fetchMock } = mockFetch([{ method: 'POST', path: '/admin/connections', status: 201, body: { id: 'c1' } }]);
    await expect(apiFetch('/admin/connections', { method: 'POST', body: { name: 'x' } })).resolves.toEqual({ id: 'c1' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"name":"x"}' });
    expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('sends no Content-Type when there is no body', async () => {
    const { fetchMock } = mockFetch([{ method: 'POST', path: '/admin/logout', status: 204 }]);
    await expect(apiFetch('/admin/logout', { method: 'POST' })).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('Content-Type');
  });

  it('returns text for non-JSON responses', async () => {
    mockFetch([{ path: '/admin/mappings/export', text: '- route: GET /a\n' }]);
    await expect(apiFetch('/admin/mappings/export')).resolves.toBe('- route: GET /a\n');
  });

  it('turns the error envelope into an ApiError', async () => {
    mockFetch([{ path: '/admin/x', status: 409, body: { error: { code: 'CONFLICT', message: 'Already exists', details: { a: 1 } } } }]);
    const error = await apiFetch('/admin/x').catch((err) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'CONFLICT', message: 'Already exists', details: { a: 1 } });
  });

  it('falls back to a generic ApiError for non-envelope errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    await expect(apiFetch('/admin/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR' });
  });

  it('reports network failures as NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(apiFetch('/admin/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('calls the unauthorized handler only for an admin-auth 401, except for the login request itself', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const envelope = { error: { code: 'UNAUTHORIZED', message: 'nope', details: {} } };
    mockFetch([
      { path: '/admin/connections', status: 401, body: envelope },
      {
        method: 'POST',
        path: '/admin/connections/c1/mappings/generate',
        status: 401,
        body: { error: { code: 'MISSING_VENDOR_TOKEN', message: 'A vendor token is required', details: {} } },
      },
      { method: 'POST', path: '/admin/login', status: 401, body: envelope },
    ]);
    await expect(apiFetch('/admin/connections')).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(apiFetch('/admin/connections/c1/mappings/generate', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 401,
      code: 'MISSING_VENDOR_TOKEN',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(apiFetch('/admin/login', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
