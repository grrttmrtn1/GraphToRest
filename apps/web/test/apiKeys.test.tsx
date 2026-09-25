import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';

vi.mock('../src/pages/SwaggerPanel', () => ({ default: () => <div>swagger-panel</div> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const KEY = { id: 'k1', label: 'dev', createdAt: '2026-09-22 10:00:00', lastUsedAt: null, rateLimit: null };

describe('API keys page', () => {
  it('lists keys', async () => {
    mockFetch([SESSION_ROUTE, { path: '/admin/api-keys', body: [KEY] }]);
    renderApp('/api-keys');
    expect(await screen.findByText('dev')).toBeTruthy();
    expect(screen.getByText('never')).toBeTruthy();
  });

  it('shows a new key once, and hides it after Done', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/api-keys', body: [] },
      { method: 'POST', path: '/admin/api-keys', status: 201, body: { id: 'k2', plaintext: 'k2.secret-value', label: 'ci' } },
    ]);
    renderApp('/api-keys');
    await screen.findByText('No API keys yet.');
    fireEvent.change(screen.getByLabelText('Label (optional)'), { target: { value: 'ci' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    expect(await screen.findByText('k2.secret-value')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ label: 'ci' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('k2.secret-value')).toBeNull();
  });

  it('hands a new key to the test panel', async () => {
    mockFetch([
      SESSION_ROUTE,
      { path: '/admin/api-keys', body: [] },
      { method: 'POST', path: '/admin/api-keys', status: 201, body: { id: 'k2', plaintext: 'k2.secret-value', label: null } },
    ]);
    renderApp('/api-keys');
    await screen.findByText('No API keys yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use in test panel' }));
    expect(await screen.findByRole('heading', { name: 'Test' })).toBeTruthy();
    expect(sessionStorage.getItem('gtr_test_api_key')).toBe('k2.secret-value');
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('k2.secret-value');
  });

  it('revokes a key after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = mockFetch([SESSION_ROUTE, { path: '/admin/api-keys', body: [KEY] }, { method: 'DELETE', path: '/admin/api-keys/k1', status: 204 }]);
    renderApp('/api-keys');
    const row = (await screen.findByText('dev')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/admin/api-keys/k1')).toBe(true));
  });

  it('shows each key’s rate limit', async () => {
    mockFetch([SESSION_ROUTE, { path: '/admin/api-keys', body: [{ ...KEY, rateLimit: { requestsPerMinute: 60, burst: 10 } }] }]);
    renderApp('/api-keys');
    expect(await screen.findByText('60/min (burst 10)')).toBeTruthy();
  });

  it('creates a key with a rate limit', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/api-keys', body: [] },
      { method: 'POST', path: '/admin/api-keys', status: 201, body: { id: 'k2', plaintext: 'k2.s', label: null, rateLimit: { requestsPerMinute: 30, burst: 30 } } },
    ]);
    renderApp('/api-keys');
    await screen.findByText('No API keys yet.');
    fireEvent.change(screen.getByLabelText('Rate limit (requests/min, empty = server default)'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    await screen.findByText('k2.s');
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ rateLimit: { requestsPerMinute: 30, burst: 30 } });
  });

  it('edits a key’s rate limit', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/api-keys', body: [KEY] },
      { method: 'PATCH', path: '/admin/api-keys/k1', body: { ...KEY, rateLimit: 'unlimited' } },
    ]);
    renderApp('/api-keys');
    const row = (await screen.findByText('dev')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit limit' }));
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: 'unlimited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ rateLimit: 'unlimited' });
  });
});
