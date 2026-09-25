export interface Session {
  username: string;
  expiresAt: string;
}

export interface Connection {
  id: string;
  name: string;
  adapterType: string;
  authMode: string;
  config: Record<string, unknown> | null;
}

export interface NewConnection {
  name: string;
  adapterType: string;
  authMode: string;
  config?: Record<string, unknown>;
}

export interface Mapping {
  id: string;
  connectionId: string;
  route: string;
  method: string;
  operation: Record<string, unknown>;
  responseTemplate: Record<string, string> | null;
  source: 'generated' | 'manual';
  cacheTtlSeconds?: number;
}

/** Only the fields that actually changed should be sent — the server flips a mapping to "manual" whenever any
 * of route/method/operation/responseTemplate is present, so an unrelated field re-sent unchanged (e.g. a TTL-only
 * edit) would wrongly flip a generated mapping's source. */
export interface MappingPatch {
  method?: string;
  route?: string;
  operation?: unknown;
  responseTemplate?: unknown;
  cacheTtlSeconds?: number | null;
}

export interface GenerationResult {
  created: unknown[];
  updated: unknown[];
  skipped: unknown[];
  conflicts: unknown[];
}

export interface ImportResult {
  imported: number;
  warnings: string[];
}

export type RateLimitSetting = { requestsPerMinute: number; burst: number } | 'unlimited' | null;

export interface ApiKeySummary {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  rateLimit: RateLimitSetting;
}

export interface CreatedApiKey {
  id: string;
  plaintext: string;
  label: string | null;
  rateLimit: RateLimitSetting;
}

export type CredentialStatus =
  | { configured: false }
  | { configured: true; grant: 'client_credentials' | 'authorization_code'; hasRefreshToken: boolean };

export interface ActivityItem {
  id: number;
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorCode: string | null;
  apiKeyId: string | null;
  apiKeyLabel: string | null;
  connectionId: string | null;
  connectionName: string | null;
  mappingId: string | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  nextBefore: number | null;
}
