import { CliError } from '../errors';
import type { ModeSource } from '../mode';
import type {
  GtrClient,
  ClientStatus,
  CreateConnectionInput,
  CreateMappingInput,
  MappingPatch,
  GenerateOptions,
  CreatedApiKey,
  ImportResult,
  ActivityQuery,
  ActivityPage,
  ConnectionRecord,
  MappingRecord,
  CredentialStatus,
  GenerationResult,
  ApiKeySummary,
  AdminUserRecord,
} from './types';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const GENERATE_TIMEOUT_MS = 120_000;

export interface RemoteClientOptions {
  server: string;
  token: string | null;
  source: ModeSource;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  /** false for /login, the only call made without a session. */
  auth?: boolean;
  expect?: 'json' | 'text' | 'none';
}

const enc = encodeURIComponent;

/** Calls a running server's /admin/* API with a bearer session token. */
export class RemoteClient implements GtrClient {
  readonly mode = 'remote' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RemoteClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static login(options: Omit<RemoteClientOptions, 'token'>, username: string, password: string): Promise<{ token: string; expiresAt: string }> {
    return new RemoteClient({ ...options, token: null }).request('POST', '/login', { body: { username, password }, auth: false });
  }

  session(): Promise<{ username: string; expiresAt: string }> {
    return this.request('GET', '/session');
  }

  async logout(): Promise<void> {
    await this.request('POST', '/logout', { expect: 'none' });
  }

  close(): void {}

  async describe(): Promise<ClientStatus> {
    const base = { mode: 'remote' as const, server: this.options.server, source: this.options.source };
    if (!this.options.token) return { ...base, session: 'not-logged-in' };
    try {
      return { ...base, session: await this.session() };
    } catch (err) {
      if (err instanceof CliError && err.code === 'UNAUTHORIZED') return { ...base, session: 'expired' };
      throw err;
    }
  }

  createConnection(input: CreateConnectionInput): Promise<ConnectionRecord> {
    return this.request('POST', '/connections', { body: input });
  }

  listConnections(): Promise<ConnectionRecord[]> {
    return this.request('GET', '/connections');
  }

  async deleteConnection(id: string): Promise<void> {
    await this.request('DELETE', `/connections/${enc(id)}`, { expect: 'none' });
  }

  setCredentials(id: string, credentials: unknown): Promise<CredentialStatus> {
    return this.request('PUT', `/connections/${enc(id)}/credentials`, { body: credentials });
  }

  getCredentialStatus(id: string): Promise<CredentialStatus> {
    return this.request('GET', `/connections/${enc(id)}/credentials`);
  }

  async clearCredentials(id: string): Promise<void> {
    await this.request('DELETE', `/connections/${enc(id)}/credentials`, { expect: 'none' });
  }

  startAuthorization(id: string): Promise<{ authorizationUrl: string }> {
    return this.request('POST', `/connections/${enc(id)}/oauth/start`);
  }

  createMapping(input: CreateMappingInput): Promise<MappingRecord> {
    return this.request('POST', '/mappings', { body: { ...input, source: 'manual' } });
  }

  listMappings(): Promise<MappingRecord[]> {
    return this.request('GET', '/mappings');
  }

  updateMapping(id: string, patch: MappingPatch): Promise<MappingRecord> {
    return this.request('PATCH', `/mappings/${enc(id)}`, { body: patch });
  }

  async deleteMapping(id: string): Promise<void> {
    await this.request('DELETE', `/mappings/${enc(id)}`, { expect: 'none' });
  }

  generateMappings(connectionId: string, options: GenerateOptions): Promise<GenerationResult> {
    return this.request('POST', `/connections/${enc(connectionId)}/mappings/generate`, {
      body: { force: options.force === true },
      headers: options.vendorToken ? { 'X-Vendor-Token': options.vendorToken } : {},
      timeoutMs: GENERATE_TIMEOUT_MS,
    });
  }

  exportMappings(options: { connectionId?: string }): Promise<string> {
    return this.request('GET', '/mappings/export', { query: { connectionId: options.connectionId }, expect: 'text' });
  }

  importMappings(yaml: string): Promise<ImportResult> {
    return this.request('POST', '/mappings/import', { body: { yaml } });
  }

  createApiKey(input: { label?: string }): Promise<CreatedApiKey> {
    return this.request('POST', '/api-keys', { body: input });
  }

  listApiKeys(): Promise<ApiKeySummary[]> {
    return this.request('GET', '/api-keys');
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.request('DELETE', `/api-keys/${enc(id)}`, { expect: 'none' });
  }

  createAdminUser(input: { username: string; password: string }): Promise<AdminUserRecord> {
    return this.request('POST', '/admin-users', { body: input });
  }

  async setAdminPassword(_input: { username: string; password: string }): Promise<never> {
    throw new CliError(
      'MODE_UNSUPPORTED',
      '"admin set-password" is embedded-only (lockout recovery): run it where the SQLite file is, without --server/GTR_SERVER and after "gtr logout"'
    );
  }

  listAdapters(): Promise<string[]> {
    return this.request('GET', '/adapters');
  }

  listActivity(query: ActivityQuery): Promise<ActivityPage> {
    return this.request('GET', '/activity', { query: { limit: query.limit, before: query.before } });
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const { server, token, source } = this.options;
    const authenticated = opts.auth !== false;
    if (authenticated && !token) {
      throw new CliError('NOT_LOGGED_IN', `Not logged in to ${server}; run "gtr login --server ${server}"`);
    }

    const url = new URL(`${server}/admin${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'TimeoutError') {
        throw new CliError('TIMEOUT', `Request to ${server} timed out after ${timeoutMs / 1000}s`);
      }
      const cause = (err as { cause?: { message?: string } } | null)?.cause?.message ?? (err as Error)?.message ?? String(err);
      throw new CliError('UNREACHABLE', `Cannot reach server at ${server} (configured via ${source}): ${cause}`);
    }

    if (!res.ok) throw await this.errorFrom(res);
    const expect = opts.expect ?? 'json';
    if (expect === 'none' || res.status === 204) return undefined as T;
    if (expect === 'text') return (await res.text()) as T;
    const contentType = res.headers.get('content-type') ?? '';
    if (!/^application\/json/i.test(contentType)) {
      throw new CliError(
        'SERVER_ERROR',
        `Unexpected response from ${server}: expected JSON but got ${contentType || 'no content type'}. Is this a GraphToRest server URL?`
      );
    }
    return (await res.json()) as T;
  }

  private async errorFrom(res: Response): Promise<CliError> {
    const { server, token } = this.options;
    if (res.status === 401 && token) {
      return new CliError('UNAUTHORIZED', `Session expired or revoked; run "gtr login --server ${server}"`);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      return new CliError(error.code, error.message);
    }
    return new CliError('SERVER_ERROR', `Server returned HTTP ${res.status}`);
  }
}
