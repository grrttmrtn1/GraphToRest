import {
  openDb,
  MappingStore,
  ManagedTokenService,
  CredentialCipher,
  registerDefaultAdapters,
  listAdapterTypes,
  buildAuthContext,
  generateAndPersistMappings,
  exportMappingsYaml,
  importMappingsYaml,
  parseMappingFields,
  parseConnectionFields,
  setOutboundPolicy,
  outboundPolicyFromEnv,
  parseRateLimitSetting,
  type ConnectionRecord,
  type RateLimitSetting,
} from '@graphtorest/core';
import { CliError } from '../errors';
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
} from './types';

const ACTIVITY_DEFAULT_LIMIT = 50;
const ACTIVITY_MAX_LIMIT = 200;

function sqliteCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function notFound(message: string): CliError {
  return new CliError('NOT_FOUND', message);
}

function invalid(message: string): CliError {
  return new CliError('INVALID_INPUT', message);
}

/**
 * Direct SQLite access through @graphtorest/core. Validation and error codes deliberately mirror
 * apps/server/src/routers/adminRouter.ts so both modes behave the same (see client.contract.test.ts).
 */
export class EmbeddedClient implements GtrClient {
  readonly mode = 'embedded' as const;

  static open(dbPath: string, env: NodeJS.ProcessEnv = process.env): EmbeddedClient {
    setOutboundPolicy(outboundPolicyFromEnv(env));
    registerDefaultAdapters();
    const db = openDb(dbPath);
    const store = new MappingStore(db);
    const key = env.CREDENTIAL_ENCRYPTION_KEY;
    return new EmbeddedClient(dbPath, db, store, key ? new ManagedTokenService(store, new CredentialCipher(key)) : undefined);
  }

  private constructor(
    readonly dbPath: string,
    private readonly db: ReturnType<typeof openDb>,
    readonly store: MappingStore,
    private readonly managedAuth: ManagedTokenService | undefined
  ) {}

  close(): void {
    this.db.close();
  }

  async describe(): Promise<ClientStatus> {
    return { mode: 'embedded', dbPath: this.dbPath, adminUsers: this.store.countAdminUsers() };
  }

  async createConnection(input: CreateConnectionInput) {
    const fields = parseConnectionFields(input);
    try {
      return this.store.createConnection(fields);
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_UNIQUE') throw new CliError('CONFLICT', 'A connection with this name already exists');
      throw err;
    }
  }

  async listConnections() {
    return this.store.listConnections();
  }

  async deleteConnection(id: string) {
    if (!this.store.getConnection(id)) throw notFound('Connection not found');
    this.managedAuth?.clearCredentials(id); // drop cached tokens and pending authorizations first, as the server does
    this.store.deleteConnection(id);
  }

  async setCredentials(id: string, credentials: unknown) {
    const [managedAuth, connection] = this.managedConnection(id);
    return managedAuth.saveCredentials(connection, credentials);
  }

  async getCredentialStatus(id: string) {
    const [managedAuth, connection] = this.managedConnection(id);
    return managedAuth.getCredentialStatus(connection.id);
  }

  async clearCredentials(id: string) {
    const [managedAuth, connection] = this.managedConnection(id);
    managedAuth.clearCredentials(connection.id);
  }

  async startAuthorization(_id: string): Promise<never> {
    throw new CliError(
      'MODE_UNSUPPORTED',
      '"connection authorize" needs remote mode: the vendor redirects to a running server\'s /admin/oauth/callback. Run "gtr login --server <url>" first.'
    );
  }

  async createMapping(input: CreateMappingInput) {
    const fields = parseMappingFields({
      route: input.route,
      method: input.method,
      operation: input.operation,
      responseTemplate: input.responseTemplate,
      cacheTtlSeconds: input.cacheTtlSeconds,
    });
    try {
      return this.store.createMapping({
        connectionId: input.connectionId,
        route: fields.route!,
        method: fields.method!,
        operation: fields.operation!,
        responseTemplate: fields.responseTemplate ?? null,
        cacheTtlSeconds: fields.cacheTtlSeconds,
        source: 'manual',
      });
    } catch (err) {
      const code = sqliteCode(err);
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') throw new CliError('CONFLICT', 'A mapping with this route and method already exists');
      if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw invalid('connectionId does not reference an existing connection');
      throw err;
    }
  }

  async listMappings() {
    return this.store.listMappings();
  }

  async updateMapping(id: string, patch: MappingPatch) {
    const fields = parseMappingFields({ ...patch });
    const definitional =
      fields.route !== undefined || fields.method !== undefined || fields.operation !== undefined || fields.responseTemplate !== undefined;
    if (!definitional && fields.cacheTtlSeconds === undefined) {
      throw invalid('At least one of route, method, operation, responseTemplate, cacheTtlSeconds is required');
    }
    let updated;
    try {
      updated = this.store.updateMapping(id, {
        route: fields.route,
        method: fields.method,
        operation: fields.operation,
        responseTemplate: fields.responseTemplate,
        cacheTtlSeconds: fields.cacheTtlSeconds,
        // Any definitional edit flips a mapping to manual (spec §5.2); a cache-TTL-only change is operational and keeps the source.
        source: definitional ? 'manual' : undefined,
      });
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_UNIQUE') throw new CliError('CONFLICT', 'A mapping with this route and method already exists');
      throw err;
    }
    if (!updated) throw notFound('Mapping not found');
    return updated;
  }

  async deleteMapping(id: string) {
    if (!this.store.deleteMapping(id)) throw notFound('Mapping not found');
  }

  async generateMappings(connectionId: string, options: GenerateOptions) {
    const connection = this.store.getConnection(connectionId);
    if (!connection) throw notFound('Connection not found');
    if (connection.authMode === 'managed' && !this.managedAuth) {
      throw new CliError(
        'MANAGED_AUTH_UNAVAILABLE',
        'Managed auth requires CREDENTIAL_ENCRYPTION_KEY to be set in this environment (embedded mode)'
      );
    }
    const authContext = await buildAuthContext(connection, options.vendorToken, this.managedAuth);
    return generateAndPersistMappings(this.store, connection, authContext, { force: options.force === true });
  }

  async exportMappings(options: { connectionId?: string }) {
    return exportMappingsYaml(this.store, { connectionId: options.connectionId });
  }

  async importMappings(yaml: string): Promise<ImportResult> {
    const { records, warnings } = importMappingsYaml(this.store, yaml);
    return { imported: records.length, warnings };
  }

  async createApiKey(input: { label?: string; rateLimit?: RateLimitSetting }): Promise<CreatedApiKey> {
    const rateLimit = input.rateLimit === undefined ? null : parseRateLimitSetting(input.rateLimit);
    const created = this.store.createApiKey({ label: input.label, rateLimit });
    return { id: created.id, plaintext: created.plaintext, label: created.label, rateLimit: created.rateLimit };
  }

  async listApiKeys() {
    return this.store.listApiKeys();
  }

  async revokeApiKey(id: string) {
    if (!this.store.deleteApiKey(id)) throw notFound('API key not found');
  }

  async updateApiKeyRateLimit(id: string, rateLimit: RateLimitSetting) {
    const updated = this.store.setApiKeyRateLimit(id, parseRateLimitSetting(rateLimit));
    if (!updated) throw notFound('API key not found');
    return updated;
  }

  async createAdminUser(input: { username: string; password: string }) {
    try {
      return this.store.createAdminUser(input);
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_UNIQUE') throw new CliError('CONFLICT', 'An admin user with this username already exists');
      throw err;
    }
  }

  async setAdminPassword(input: { username: string; password: string }) {
    if (!this.store.setAdminPassword(input.username, input.password)) throw notFound(`No admin user named "${input.username}"`);
  }

  async listAdapters() {
    return listAdapterTypes();
  }

  async listActivity(query: ActivityQuery): Promise<ActivityPage> {
    const limit = query.limit ?? ACTIVITY_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_MAX_LIMIT) {
      throw invalid(`"limit" must be an integer from 1 to ${ACTIVITY_MAX_LIMIT}`);
    }
    if (query.before !== undefined && (!Number.isInteger(query.before) || query.before < 1)) {
      throw invalid('"before" must be a positive integer');
    }
    const items = this.store.listRequests({ limit, before: query.before });
    return { items, nextBefore: items.length === limit ? items[items.length - 1].id : null };
  }

  /** Same order as the server: managed auth configured → connection exists → connection is managed. */
  private managedConnection(id: string): [ManagedTokenService, ConnectionRecord] {
    if (!this.managedAuth) {
      throw new CliError(
        'MANAGED_AUTH_DISABLED',
        'Managed auth is disabled: set CREDENTIAL_ENCRYPTION_KEY in this environment to manage stored credentials in embedded mode'
      );
    }
    const connection = this.store.getConnection(id);
    if (!connection) throw notFound('Connection not found');
    if (connection.authMode !== 'managed') throw invalid('The connection authMode must be "managed" to use stored credentials');
    return [this.managedAuth, connection];
  }
}
