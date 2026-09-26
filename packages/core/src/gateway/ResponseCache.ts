import crypto from 'node:crypto';

export interface ResponseCacheOptions {
  maxEntries: number;
  maxTtlSeconds: number;
  /** Upper bound on the summed UTF-8 size of stored bodies; 0 or absent means no byte bound. */
  maxBytes?: number;
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
  bytes: number;
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
  private totalBytes = 0;
  private currentEpoch = 0;

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

  get bytes(): number {
    return this.totalBytes;
  }

  /**
   * Advances on every eviction. A caller captures it before calling the vendor and passes it to `set`, so a response
   * fetched before an admin change (mapping edit, credential change) cannot repopulate the cache after it. The counter
   * is deliberately global: any eviction also drops in-flight writes for unrelated mappings, which costs at most one
   * extra MISS each and never serves stale data.
   */
  get epoch(): number {
    return this.currentEpoch;
  }

  get(key: string): unknown | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) {
      this.totalBytes -= entry.bytes;
      return undefined;
    }
    this.entries.set(key, entry); // most recently used goes last
    return JSON.parse(entry.body);
  }

  set(key: string, value: unknown, meta: { mappingId: string; connectionId: string; ttlSeconds: number; epoch?: number }): void {
    if (meta.ttlSeconds <= 0 || this.options.maxEntries <= 0) return;
    if (meta.epoch !== undefined && meta.epoch !== this.currentEpoch) return;
    const body = JSON.stringify(value);
    if (body === undefined) return;
    const bytes = Buffer.byteLength(body);
    const maxBytes = this.options.maxBytes ?? 0;
    if (maxBytes > 0 && bytes > maxBytes) return; // never flush the cache for one entry that could not fit anyway
    this.remove(key);
    this.entries.set(key, { body, bytes, expiresAt: this.now() + meta.ttlSeconds * 1000, mappingId: meta.mappingId, connectionId: meta.connectionId });
    this.totalBytes += bytes;
    while (this.entries.size > this.options.maxEntries || (maxBytes > 0 && this.totalBytes > maxBytes)) {
      this.remove(this.entries.keys().next().value as string);
    }
  }

  evictMapping(mappingId: string): void {
    this.currentEpoch += 1;
    for (const [key, entry] of this.entries) if (entry.mappingId === mappingId) this.remove(key);
  }

  evictConnection(connectionId: string): void {
    this.currentEpoch += 1;
    for (const [key, entry] of this.entries) if (entry.connectionId === connectionId) this.remove(key);
  }

  clear(): void {
    this.currentEpoch += 1;
    this.entries.clear();
    this.totalBytes = 0;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }
}
