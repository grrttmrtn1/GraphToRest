import crypto from 'node:crypto';

export interface ResponseCacheOptions {
  maxEntries: number;
  maxTtlSeconds: number;
  now?: () => number;
}

export interface CacheKeyParts {
  mappingId: string;
  path: string;
  query: Record<string, unknown>;
  identity: string;
}

interface Entry {
  body: string;
  expiresAt: number;
  mappingId: string;
  connectionId: string;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Whose data a response is. Managed connections call the vendor as one identity, so every API key shares entries;
 * passthrough responses belong to the vendor token (hashed — raw tokens are never kept), including "no token".
 */
export function cacheIdentity(connection: { id: string; authMode: string }, vendorToken: string | undefined): string {
  return connection.authMode === 'managed' ? `conn:${connection.id}` : `tok:${sha256(vendorToken ?? '')}`;
}

/** In-memory LRU of successful GET responses with per-entry TTLs (single-process deployment, spec §6.3). */
export class ResponseCache {
  private entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly options: ResponseCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  static key(parts: CacheKeyParts): string {
    const query = Object.keys(parts.query)
      .sort()
      .map((name) => [name, parts.query[name]]);
    return sha256(JSON.stringify([parts.mappingId, parts.path, query, parts.identity]));
  }

  ttlFor(cacheTtlSeconds: number | undefined): number {
    if (this.options.maxEntries <= 0 || !cacheTtlSeconds || cacheTtlSeconds <= 0) return 0;
    return Math.min(cacheTtlSeconds, this.options.maxTtlSeconds);
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): unknown | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(key, entry); // most recently used goes last
    return JSON.parse(entry.body);
  }

  set(key: string, value: unknown, meta: { mappingId: string; connectionId: string; ttlSeconds: number }): void {
    if (meta.ttlSeconds <= 0 || this.options.maxEntries <= 0) return;
    const body = JSON.stringify(value);
    if (body === undefined) return;
    this.entries.delete(key);
    this.entries.set(key, { body, expiresAt: this.now() + meta.ttlSeconds * 1000, mappingId: meta.mappingId, connectionId: meta.connectionId });
    while (this.entries.size > this.options.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
  }

  evictMapping(mappingId: string): void {
    for (const [key, entry] of this.entries) if (entry.mappingId === mappingId) this.entries.delete(key);
  }

  evictConnection(connectionId: string): void {
    for (const [key, entry] of this.entries) if (entry.connectionId === connectionId) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
