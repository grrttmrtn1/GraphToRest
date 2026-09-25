import type {
  ActivityPage,
  ApiKeySummary,
  Connection,
  CreatedApiKey,
  CredentialStatus,
  GenerationResult,
  ImportResult,
  Mapping,
  MappingPatch,
  NewConnection,
  RateLimitSetting,
  Session,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let unauthorizedHandler: () => void = () => {};

/** Registered by the app root: a 401 from any admin call (other than login) ends the client-side session. */
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let response: Response;
  try {
    response = await fetch(path, { method: init.method ?? 'GET', headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server');
  }
  if (response.status === 401 && path !== '/admin/login') unauthorizedHandler();
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? await response.json() : await response.text()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const error = (await response.json())?.error;
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      return new ApiError(response.status, error.code, error.message, error.details ?? {});
    }
  } catch {
    // not a JSON error envelope
  }
  return new ApiError(response.status, 'HTTP_ERROR', `Request failed with status ${response.status}`);
}

const enc = encodeURIComponent;

export const api = {
  session: () => apiFetch<Session>('/admin/session'),
  login: (username: string, password: string) =>
    apiFetch<Session>('/admin/login', { method: 'POST', body: { username, password, session: 'cookie' } }),
  logout: () => apiFetch<void>('/admin/logout', { method: 'POST' }),

  adapters: () => apiFetch<string[]>('/admin/adapters'),
  connections: () => apiFetch<Connection[]>('/admin/connections'),
  createConnection: (input: NewConnection) => apiFetch<Connection>('/admin/connections', { method: 'POST', body: input }),
  deleteConnection: (id: string) => apiFetch<void>(`/admin/connections/${enc(id)}`, { method: 'DELETE' }),

  credentialStatus: (id: string) => apiFetch<CredentialStatus>(`/admin/connections/${enc(id)}/credentials`),
  saveCredentials: (id: string, input: Record<string, unknown>) =>
    apiFetch<CredentialStatus>(`/admin/connections/${enc(id)}/credentials`, { method: 'PUT', body: input }),
  clearCredentials: (id: string) => apiFetch<void>(`/admin/connections/${enc(id)}/credentials`, { method: 'DELETE' }),
  startAuthorization: (id: string) =>
    apiFetch<{ authorizationUrl: string }>(`/admin/connections/${enc(id)}/oauth/start`, { method: 'POST' }),

  mappings: () => apiFetch<Mapping[]>('/admin/mappings'),
  generateMappings: (connectionId: string, options: { force?: boolean; vendorToken?: string }) =>
    apiFetch<GenerationResult>(`/admin/connections/${enc(connectionId)}/mappings/generate`, {
      method: 'POST',
      body: { force: options.force === true },
      headers: options.vendorToken ? { 'X-Vendor-Token': options.vendorToken } : {},
    }),
  updateMapping: (id: string, patch: MappingPatch) => apiFetch<Mapping>(`/admin/mappings/${enc(id)}`, { method: 'PATCH', body: patch }),
  deleteMapping: (id: string) => apiFetch<void>(`/admin/mappings/${enc(id)}`, { method: 'DELETE' }),
  exportMappings: (connectionId?: string) =>
    apiFetch<string>(`/admin/mappings/export${connectionId ? `?connectionId=${enc(connectionId)}` : ''}`, {
      headers: { Accept: 'text/yaml' },
    }),
  importMappings: (yaml: string) => apiFetch<ImportResult>('/admin/mappings/import', { method: 'POST', body: { yaml } }),

  apiKeys: () => apiFetch<ApiKeySummary[]>('/admin/api-keys'),
  createApiKey: (input: { label?: string; rateLimit?: RateLimitSetting }) =>
    apiFetch<CreatedApiKey>('/admin/api-keys', { method: 'POST', body: input }),
  updateApiKeyRateLimit: (id: string, rateLimit: RateLimitSetting) =>
    apiFetch<ApiKeySummary>(`/admin/api-keys/${enc(id)}`, { method: 'PATCH', body: { rateLimit } }),
  deleteApiKey: (id: string) => apiFetch<void>(`/admin/api-keys/${enc(id)}`, { method: 'DELETE' }),

  activity: (before?: number) =>
    apiFetch<ActivityPage>(`/admin/activity?limit=50${before !== undefined ? `&before=${before}` : ''}`),
};
