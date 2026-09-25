import type {
  ConnectionRecord,
  MappingRecord,
  ApiKeySummary,
  AdminUserRecord,
  RequestLogRecord,
  GenerationResult,
  CredentialStatus,
  RateLimitSetting,
} from '@graphtorest/core';
import type { ModeSource } from '../mode';

export type {
  ConnectionRecord,
  MappingRecord,
  ApiKeySummary,
  AdminUserRecord,
  RequestLogRecord,
  GenerationResult,
  CredentialStatus,
  RateLimitSetting,
};

export interface CreateConnectionInput {
  name: string;
  adapterType: string;
  authMode: string;
  config?: Record<string, unknown> | null;
}

export interface CreateMappingInput {
  connectionId: string;
  method: string;
  route: string;
  operation: Record<string, unknown>;
  responseTemplate?: Record<string, string> | null;
  cacheTtlSeconds?: number | null;
}

export interface MappingPatch {
  method?: string;
  route?: string;
  operation?: Record<string, unknown>;
  responseTemplate?: Record<string, string> | null;
  cacheTtlSeconds?: number | null;
}

export interface GenerateOptions {
  force?: boolean;
  vendorToken?: string;
}

export interface CreatedApiKey {
  id: string;
  plaintext: string;
  label: string | null;
  rateLimit: RateLimitSetting;
}

export interface ImportResult {
  imported: number;
  warnings: string[];
}

export interface ActivityQuery {
  limit?: number;
  before?: number;
}

export interface ActivityPage {
  items: RequestLogRecord[];
  nextBefore: number | null;
}

export type SessionState = { username: string; expiresAt: string } | 'not-logged-in' | 'expired';

export type ClientStatus =
  | { mode: 'embedded'; dbPath: string; adminUsers: number }
  | { mode: 'remote'; server: string; source: ModeSource; session: SessionState };

/**
 * Everything a command can do, in either mode. Both implementations must behave identically, including error
 * codes; client.contract.test.ts is the proof.
 */
export interface GtrClient {
  readonly mode: 'embedded' | 'remote';
  describe(): Promise<ClientStatus>;
  close(): void;

  createConnection(input: CreateConnectionInput): Promise<ConnectionRecord>;
  listConnections(): Promise<ConnectionRecord[]>;
  deleteConnection(id: string): Promise<void>;
  setCredentials(id: string, credentials: unknown): Promise<CredentialStatus>;
  getCredentialStatus(id: string): Promise<CredentialStatus>;
  clearCredentials(id: string): Promise<void>;
  /** Remote only: the vendor redirects back to the server's /admin/oauth/callback. */
  startAuthorization(id: string): Promise<{ authorizationUrl: string }>;

  createMapping(input: CreateMappingInput): Promise<MappingRecord>;
  listMappings(): Promise<MappingRecord[]>;
  updateMapping(id: string, patch: MappingPatch): Promise<MappingRecord>;
  deleteMapping(id: string): Promise<void>;
  generateMappings(connectionId: string, options: GenerateOptions): Promise<GenerationResult>;
  exportMappings(options: { connectionId?: string }): Promise<string>;
  importMappings(yaml: string): Promise<ImportResult>;

  createApiKey(input: { label?: string; rateLimit?: RateLimitSetting }): Promise<CreatedApiKey>;
  listApiKeys(): Promise<ApiKeySummary[]>;
  revokeApiKey(id: string): Promise<void>;
  updateApiKeyRateLimit(id: string, rateLimit: RateLimitSetting): Promise<ApiKeySummary>;

  createAdminUser(input: { username: string; password: string }): Promise<AdminUserRecord>;
  /** Embedded only: lockout recovery, no remote endpoint exists. */
  setAdminPassword(input: { username: string; password: string }): Promise<void>;

  listAdapters(): Promise<string[]>;
  listActivity(query: ActivityQuery): Promise<ActivityPage>;
}
