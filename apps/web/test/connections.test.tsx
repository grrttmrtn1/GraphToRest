import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';
import { redirectBrowser } from '../src/browser';
import { toCredentialInput } from '../src/pages/CredentialsTab';

vi.mock('../src/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser')>()),
  redirectBrowser: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(redirectBrowser).mockReset();
});

const MOCK_CONN = { id: 'c1', name: 'mock-conn', adapterType: 'mock', authMode: 'passthrough', config: null };
const GQL_CONN = { id: 'c2', name: 'gql', adapterType: 'graphql', authMode: 'passthrough', config: { endpoint: 'https://api.example.com/graphql' } };
const MS_CONN = { id: 'c3', name: 'ms', adapterType: 'microsoft-graph', authMode: 'managed', config: null };
const ADAPTERS = { path: '/admin/adapters', body: ['mock', 'microsoft-graph', 'graphql'] };

describe('connections list', () => {
  it('lists connections with links', async () => {
    mockFetch([SESSION_ROUTE, ADAPTERS, { path: '/admin/connections', body: [MOCK_CONN, GQL_CONN] }]);
    renderApp('/connections');
    const link = await screen.findByRole('link', { name: 'mock-conn' });
    expect(link.getAttribute('href')).toBe('/connections/c1');
    expect(screen.getByRole('link', { name: 'gql' })).toBeTruthy();
  });

  it('creates a GraphQL connection with its endpoint and opens it', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      ADAPTERS,
      { path: '/admin/connections', body: [MOCK_CONN, GQL_CONN] },
      { method: 'POST', path: '/admin/connections', status: 201, body: GQL_CONN },
    ]);
    renderApp('/connections');
    await screen.findByRole('link', { name: 'mock-conn' });
    await screen.findByRole('option', { name: 'GraphQL' });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'gql' } });
    fireEvent.change(screen.getByLabelText('Adapter'), { target: { value: 'graphql' } });
    fireEvent.change(screen.getByLabelText('GraphQL endpoint URL'), { target: { value: 'https://api.example.com/graphql' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    expect(await screen.findByRole('heading', { name: 'gql' })).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/admin/connections')!.body).toEqual({
      name: 'gql',
      adapterType: 'graphql',
      authMode: 'passthrough',
      config: { endpoint: 'https://api.example.com/graphql' },
    });
  });

  it('omits config for non-GraphQL adapters and shows server errors', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      ADAPTERS,
      { path: '/admin/connections', body: [] },
      { method: 'POST', path: '/admin/connections', status: 409, body: { error: { code: 'CONFLICT', message: 'A connection with this name already exists', details: {} } } },
    ]);
    renderApp('/connections');
    await screen.findByText('No connections yet.');
    await screen.findByRole('option', { name: 'Mock' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'dup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    expect(await screen.findByText('A connection with this name already exists')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'dup', adapterType: 'mock', authMode: 'passthrough' });
  });

  it('imports mappings from a YAML file and shows the result and warnings', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      ADAPTERS,
      { path: '/admin/connections', body: [MOCK_CONN] },
      { method: 'POST', path: '/admin/mappings/import', body: { imported: 2, warnings: ['2 generated mapping(s) are now source=manual'] } },
    ]);
    renderApp('/connections');
    await screen.findByRole('link', { name: 'mock-conn' });
    const file = new File(['- route: GET /a\n'], 'mappings.yaml', { type: 'text/yaml' });
    fireEvent.change(screen.getByLabelText('YAML file'), { target: { files: [file] } });
    expect(await screen.findByText('Imported 2 mapping(s).')).toBeTruthy();
    expect(screen.getByText('2 generated mapping(s) are now source=manual')).toBeTruthy();
    expect(calls.find((c) => c.path === '/admin/mappings/import')!.body).toEqual({ yaml: '- route: GET /a\n' });
  });

  it('shows an OAuth error banner on the list page', async () => {
    mockFetch([SESSION_ROUTE, ADAPTERS, { path: '/admin/connections', body: [] }]);
    renderApp('/connections?oauth=error&code=INVALID_STATE');
    expect(await screen.findByText('Authorization failed (INVALID_STATE).')).toBeTruthy();
  });
});

describe('connection page', () => {
  it('shows the overview and deletes after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = mockFetch([
      SESSION_ROUTE,
      ADAPTERS,
      { path: '/admin/connections', body: [MOCK_CONN] },
      { method: 'DELETE', path: '/admin/connections/c1', status: 204 },
    ]);
    renderApp('/connections/c1');
    expect(await screen.findByRole('heading', { name: 'mock-conn' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Credentials' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }));
    await screen.findByRole('heading', { name: 'Connections' });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/admin/connections/c1')).toBe(true);
  });

  it('does not delete when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { calls } = mockFetch([SESSION_ROUTE, { path: '/admin/connections', body: [MOCK_CONN] }]);
    renderApp('/connections/c1');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete connection' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('reports an unknown connection', async () => {
    mockFetch([SESSION_ROUTE, { path: '/admin/connections', body: [MOCK_CONN] }]);
    renderApp('/connections/nope');
    expect(await screen.findByRole('heading', { name: 'Connection not found' })).toBeTruthy();
  });
});

describe('credentials tab', () => {
  it('saves Microsoft client credentials and shows the new status', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/connections', body: [MS_CONN] },
      { path: '/admin/connections/c3/credentials', body: { configured: false } },
      { method: 'PUT', path: '/admin/connections/c3/credentials', body: { configured: true, grant: 'client_credentials', hasRefreshToken: false } },
    ]);
    renderApp('/connections/c3');
    fireEvent.click(await screen.findByRole('tab', { name: 'Credentials' }));
    expect(await screen.findByText('No credentials stored.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'shh' } });
    fireEvent.change(screen.getByLabelText('Tenant ID'), { target: { value: 'tenant-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save credentials' }));

    expect(await screen.findByText('Configured: client_credentials grant.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ grant: 'client_credentials', clientId: 'cid', clientSecret: 'shh', tenantId: 'tenant-1' });
    expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
  });

  it('starts authorization and sends the browser to the vendor', async () => {
    mockFetch([
      SESSION_ROUTE,
      { path: '/admin/connections', body: [MS_CONN] },
      { path: '/admin/connections/c3/credentials', body: { configured: true, grant: 'authorization_code', hasRefreshToken: false } },
      { method: 'POST', path: '/admin/connections/c3/oauth/start', body: { authorizationUrl: 'https://login.example/authorize?x=1' } },
    ]);
    renderApp('/connections/c3');
    fireEvent.click(await screen.findByRole('tab', { name: 'Credentials' }));
    expect(await screen.findByText('Configured: authorization_code grant, not yet authorized.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(redirectBrowser).toHaveBeenCalledWith('https://login.example/authorize?x=1'));
  });

  it('opens on the credentials tab with the OAuth result banner after the callback redirect', async () => {
    mockFetch([
      SESSION_ROUTE,
      { path: '/admin/connections', body: [MS_CONN] },
      { path: '/admin/connections/c3/credentials', body: { configured: true, grant: 'authorization_code', hasRefreshToken: true } },
    ]);
    renderApp('/connections/c3?oauth=success');
    expect(await screen.findByText('Authorization completed.')).toBeTruthy();
    expect(await screen.findByText('Configured: authorization_code grant, authorized.')).toBeTruthy();
  });

  it('clears credentials after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/connections', body: [MS_CONN] },
      { path: '/admin/connections/c3/credentials', body: { configured: true, grant: 'client_credentials', hasRefreshToken: false } },
      { method: 'DELETE', path: '/admin/connections/c3/credentials', status: 204 },
    ]);
    renderApp('/connections/c3');
    fireEvent.click(await screen.findByRole('tab', { name: 'Credentials' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear credentials' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });
});

describe('toCredentialInput', () => {
  const form = {
    grant: 'authorization_code' as const,
    clientId: 'cid',
    clientSecret: 'shh',
    tenantId: 't1',
    tokenUrl: 'https://auth.example/token',
    authorizeUrl: 'https://auth.example/authorize',
    scopes: ' read  write ',
  };

  it('builds a Microsoft payload with a tenant and split scopes', () => {
    expect(toCredentialInput('microsoft-graph', form)).toEqual({
      grant: 'authorization_code',
      clientId: 'cid',
      clientSecret: 'shh',
      tenantId: 't1',
      scopes: ['read', 'write'],
    });
  });

  it('builds a generic payload with token and authorize URLs', () => {
    expect(toCredentialInput('graphql', { ...form, scopes: '' })).toEqual({
      grant: 'authorization_code',
      clientId: 'cid',
      clientSecret: 'shh',
      tokenUrl: 'https://auth.example/token',
      authorizeUrl: 'https://auth.example/authorize',
    });
    expect(toCredentialInput('graphql', { ...form, grant: 'client_credentials', scopes: '' })).not.toHaveProperty('authorizeUrl');
  });
});
