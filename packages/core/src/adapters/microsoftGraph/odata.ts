export interface NormalizedRequestQuery {
  select?: string;
  filter?: string;
  expand?: string;
  limit?: number;
  cursor?: string;
}

export function normalizeRequestQuery(query?: Record<string, string>): NormalizedRequestQuery {
  if (!query) return {};
  const normalized: NormalizedRequestQuery = {};
  if (query.select) normalized.select = query.select;
  if (query.filter) normalized.filter = query.filter;
  if (query.expand) normalized.expand = query.expand;
  if (query.limit) {
    const parsed = Number(query.limit);
    if (Number.isFinite(parsed) && parsed > 0) normalized.limit = parsed;
  }
  if (query.cursor) normalized.cursor = query.cursor;
  return normalized;
}

export function encodeCursor(nextUrl: string): string {
  return Buffer.from(nextUrl, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

export function interpolatePath(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for template "${template}"`);
    }
    return encodeURIComponent(value);
  });
}
