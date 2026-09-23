import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';
import { downloadText } from '../src/browser';
import { summarizeOperation } from '../src/pages/MappingsTab';

vi.mock('../src/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser')>()),
  downloadText: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(downloadText).mockReset();
});

const CONN = { id: 'c1', name: 'mock-conn', adapterType: 'mock', authMode: 'passthrough', config: null };
const MAPPING = {
  id: 'm1',
  connectionId: 'c1',
  route: '/users/{id}',
  method: 'GET',
  operation: { query: 'user(id: $id) { id }' },
  responseTemplate: { id: '$.id' },
  source: 'generated',
};
const OTHER = { ...MAPPING, id: 'm2', connectionId: 'other', route: '/elsewhere' };

async function openMappingsTab(extraRoutes: Parameters<typeof mockFetch>[0] = []) {
  const mocked = mockFetch([
    SESSION_ROUTE,
    { path: '/admin/connections', body: [CONN] },
    { path: '/admin/mappings', body: [MAPPING, OTHER] },
    ...extraRoutes,
  ]);
  renderApp('/connections/c1');
  fireEvent.click(await screen.findByRole('tab', { name: 'Mappings' }));
  await screen.findByRole('button', { name: '/users/{id}' });
  return mocked;
}

describe('mappings tab', () => {
  it('lists only this connection’s mappings', async () => {
    await openMappingsTab();
    expect(screen.queryByText('/elsewhere')).toBeNull();
    expect(screen.getByText('generated')).toBeTruthy();
  });

  it('generates with the vendor token header and reports counts', async () => {
    const { calls } = await openMappingsTab([
      { method: 'POST', path: '/admin/connections/c1/mappings/generate', body: { created: [1, 2], updated: [], skipped: [1], conflicts: [] } },
    ]);
    fireEvent.change(screen.getByLabelText('Vendor token'), { target: { value: 'vendor-abc' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Overwrite manual mappings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate mappings' }));
    expect(await screen.findByText('Created 2, updated 0, skipped 1, conflicts 0.')).toBeTruthy();
    const call = calls.find((c) => c.path === '/admin/connections/c1/mappings/generate')!;
    expect(call.body).toEqual({ force: true });
    expect(call.headers['X-Vendor-Token']).toBe('vendor-abc');
  });

  it('saves an edit as a PATCH with parsed JSON', async () => {
    const { calls } = await openMappingsTab([{ method: 'PATCH', path: '/admin/mappings/m1', body: { ...MAPPING, route: '/people/{id}', source: 'manual' } }]);
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    fireEvent.change(screen.getByLabelText('Route'), { target: { value: '/people/{id}' } });
    fireEvent.change(screen.getByLabelText('Response template (JSON, empty for passthrough)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      method: 'GET',
      route: '/people/{id}',
      operation: { query: 'user(id: $id) { id }' },
      responseTemplate: null,
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save mapping' })).toBeNull());
  });

  it('shows server validation errors inline and keeps the form open', async () => {
    await openMappingsTab([
      {
        method: 'PATCH',
        path: '/admin/mappings/m1',
        status: 400,
        body: { error: { code: 'INVALID_INPUT', message: '"route" must be a path starting with "/" and containing no whitespace', details: {} } },
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    fireEvent.change(screen.getByLabelText('Route'), { target: { value: 'no-slash' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(await screen.findByText('"route" must be a path starting with "/" and containing no whitespace')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save mapping' })).toBeTruthy();
  });

  it('rejects invalid JSON locally without calling the server', async () => {
    const { calls } = await openMappingsTab();
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    fireEvent.change(screen.getByLabelText('Operation (JSON)'), { target: { value: '{ not json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(await screen.findByText(/Operation is not valid JSON/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('deletes a mapping after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = await openMappingsTab([{ method: 'DELETE', path: '/admin/mappings/m1', status: 204 }]);
    const row = screen.getByRole('button', { name: '/users/{id}' }).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/admin/mappings/m1')).toBe(true));
  });

  it('downloads this connection’s YAML', async () => {
    await openMappingsTab([{ path: '/admin/mappings/export?connectionId=c1', text: '- route: GET /users/{id}\n' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Export YAML' }));
    await waitFor(() => expect(downloadText).toHaveBeenCalledWith('mock-conn-mappings.yaml', '- route: GET /users/{id}\n'));
  });

  it('hides the vendor token field for managed connections', async () => {
    mockFetch([
      SESSION_ROUTE,
      { path: '/admin/connections', body: [{ ...CONN, authMode: 'managed' }] },
      { path: '/admin/mappings', body: [] },
    ]);
    renderApp('/connections/c1');
    fireEvent.click(await screen.findByRole('tab', { name: 'Mappings' }));
    await screen.findByText('No mappings for this connection yet.');
    expect(screen.queryByLabelText('Vendor token')).toBeNull();
  });
});

describe('summarizeOperation', () => {
  it('truncates long operations', () => {
    expect(summarizeOperation({ q: 'x' })).toBe('{"q":"x"}');
    const long = summarizeOperation({ query: 'y'.repeat(200) });
    expect(long).toHaveLength(80);
    expect(long.endsWith('...')).toBe(true);
  });
});
