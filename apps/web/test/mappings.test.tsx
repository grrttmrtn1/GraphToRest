import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';
import { downloadText } from '../src/browser';
import { mappingYamlExample, summarizeOperation } from '../src/pages/MappingsTab';
import { operationExample } from '../src/pages/MappingEditForm';

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
  fireEvent.click(await screen.findByRole('tab', { name: 'Endpoints' }));
  await screen.findByRole('button', { name: '/users/{id}' });
  return mocked;
}

describe('mappings tab', () => {
  it('lists only this connection’s mappings', async () => {
    await openMappingsTab();
    expect(screen.queryByText('/elsewhere')).toBeNull();
    expect(screen.getAllByText('generated')).toHaveLength(2);
  });

  it('explains where mappings come from and shows their format in context', async () => {
    await openMappingsTab();
    expect(screen.getByRole('heading', { name: 'How REST endpoints are created' })).toBeTruthy();
    expect(screen.getByText(/adapter for the upstream operations/)).toBeTruthy();
    expect(screen.getByText(/adapter supplies the upstream operations/)).toBeTruthy();
    expect(screen.getByText(/automatically generates its own OpenAPI document/)).toBeTruthy();
    fireEvent.click(screen.getByText('View field reference and YAML example'));
    expect(screen.getByText('What each field means')).toBeTruthy();
    expect(screen.getByText((_, element) => element?.tagName === 'P' && (element.textContent?.includes('connection must exactly match') ?? false))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    fireEvent.click(screen.getByText('Show adapter operation example'));
    expect(screen.getByText(/Set a variable to/)).toBeTruthy();
  });

  it('generates with the vendor token header and reports counts', async () => {
    const { calls } = await openMappingsTab([
      { method: 'POST', path: '/admin/connections/c1/mappings/generate', body: { created: [1, 2], updated: [], skipped: [1], conflicts: [] } },
    ]);
    fireEvent.change(screen.getByLabelText('Vendor token'), { target: { value: 'vendor-abc' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Overwrite manual mappings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discover and create endpoints' }));
    expect(await screen.findByText('Endpoints: 2 created, 0 updated, 1 skipped, 0 conflicts.')).toBeTruthy();
    const call = calls.find((c) => c.path === '/admin/connections/c1/mappings/generate')!;
    expect(call.body).toEqual({ force: true });
    expect(call.headers['X-Vendor-Token']).toBe('vendor-abc');
  });

  it('shows a vendor-auth 401 inline without ending the admin session', async () => {
    await openMappingsTab([
      {
        method: 'POST',
        path: '/admin/connections/c1/mappings/generate',
        status: 401,
        body: { error: { code: 'MISSING_VENDOR_TOKEN', message: 'This request requires a vendor access token', details: {} } },
      },
    ]);
    fireEvent.change(screen.getByLabelText('Vendor token'), { target: { value: 'expired-vendor-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discover and create endpoints' }));
    expect(await screen.findByText('This request requires a vendor access token')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'mock-conn' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
  });

  it('saves an edit as a PATCH containing only the fields that changed', async () => {
    const { calls } = await openMappingsTab([{ method: 'PATCH', path: '/admin/mappings/m1', body: { ...MAPPING, route: '/people/{id}', source: 'manual' } }]);
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    expect(screen.queryByText(/Saving marks this mapping as manual/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Route'), { target: { value: '/people/{id}' } });
    expect(screen.getByText(/Saving marks this mapping as manual/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Response template (JSON, empty for passthrough)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    // method and operation were left untouched, so they must not be sent (only route and responseTemplate changed).
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      route: '/people/{id}',
      responseTemplate: null,
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save mapping' })).toBeNull());
  });

  it('sends a TTL-only edit as just cacheTtlSeconds, so a generated mapping is not flipped to manual (M3)', async () => {
    const { calls } = await openMappingsTab([{ method: 'PATCH', path: '/admin/mappings/m1', body: { ...MAPPING, cacheTtlSeconds: 120, source: 'generated' } }]);
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    expect((screen.getByLabelText('Cache TTL (seconds, 0 = off)') as HTMLInputElement).value).toBe('0');
    fireEvent.change(screen.getByLabelText('Cache TTL (seconds, 0 = off)'), { target: { value: '120' } });
    // A TTL change is operational, not definitional: the "marks as manual" note must not appear.
    expect(screen.queryByText(/Saving marks this mapping as manual/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    // Nothing else present: route/method/operation/responseTemplate would each flip the mapping to "manual" server-side.
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ cacheTtlSeconds: 120 });
  });

  it('sends no PATCH at all when nothing in the form changed', async () => {
    const { calls } = await openMappingsTab();
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save mapping' })).toBeNull());
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('rejects a non-integer cache TTL locally', async () => {
    const { calls } = await openMappingsTab([]);
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    fireEvent.change(screen.getByLabelText('Cache TTL (seconds, 0 = off)'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(await screen.findByText('Cache TTL must be a whole number of seconds from 0 to 86400')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
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

  it('imports YAML without leaving the mapping screen', async () => {
    const { calls } = await openMappingsTab([
      { method: 'POST', path: '/admin/mappings/import', body: { imported: 1, warnings: ['Imported mappings are manual'] } },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Import YAML' }));
    expect(screen.getByRole('heading', { name: 'Import endpoints from YAML' })).toBeTruthy();
    expect(screen.getByText(/whole file is rejected if any entry is invalid/)).toBeTruthy();
    const file = new File(['- route: GET /a\n'], 'mappings.yaml', { type: 'text/yaml' });
    fireEvent.change(screen.getByLabelText('Import mappings YAML'), { target: { files: [file] } });
    expect(await screen.findByText('Imported 1 mapping(s).')).toBeTruthy();
    expect(screen.getByText('Imported mappings are manual')).toBeTruthy();
    expect(calls.find((c) => c.path === '/admin/mappings/import')!.body).toEqual({ yaml: '- route: GET /a\n' });
  });

  it('rejects non-object operations and non-string response templates locally', async () => {
    const { calls } = await openMappingsTab();
    fireEvent.click(screen.getByRole('button', { name: '/users/{id}' }));
    fireEvent.change(screen.getByLabelText('Operation (JSON)'), { target: { value: '[]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(await screen.findByText('Operation must be a JSON object')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Operation (JSON)'), { target: { value: '{}' } });
    fireEvent.change(screen.getByLabelText('Response template (JSON, empty for passthrough)'), { target: { value: '{"id": 1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(await screen.findByText('Response template must be a JSON object whose values are field-path strings')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('hides the vendor token field for managed connections', async () => {
    mockFetch([
      SESSION_ROUTE,
      { path: '/admin/connections', body: [{ ...CONN, authMode: 'managed' }] },
      { path: '/admin/mappings', body: [] },
    ]);
    renderApp('/connections/c1');
    fireEvent.click(await screen.findByRole('tab', { name: 'Endpoints' }));
    await screen.findByText('No REST endpoints for this connection yet.');
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

describe('mapping examples', () => {
  it('shows adapter-specific operations and a complete import shape', () => {
    expect(operationExample('microsoft-graph')).toEqual({ kind: 'get', path: '/users/{id}' });
    expect(operationExample('graphql')).toMatchObject({ variables: { id: '$params.id' } });
    expect(mappingYamlExample({ ...CONN, name: 'customer-directory' })).toContain('connection: "customer-directory"');
    expect(mappingYamlExample({ ...CONN, adapterType: 'graphql' })).toContain('\n  operation:\n    query:');
    expect(mappingYamlExample({ ...CONN, adapterType: 'graphql' })).toContain("id: '$.user.id'");
    expect(mappingYamlExample({ ...CONN, name: 'ms', adapterType: 'microsoft-graph' })).toContain('\n  operation:\n    kind: get');
  });
});
