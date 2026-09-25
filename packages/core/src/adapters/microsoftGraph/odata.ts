import { GatewayError } from '../../gateway/errors';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';

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

/**
 * Validates a decoded `?cursor=` value before it is used as an absolute request path. The Microsoft Graph SDK
 * treats any string containing "https://" as an absolute URL and sends it to that URL's own host, so an
 * unvalidated cursor is an SSRF vector (any host) and, for managed connections whose app token the SDK attaches
 * automatically, an authorization-scope escape (any Graph resource, not just the ones the admin mapped).
 *
 * Requires: origin exactly `https://graph.microsoft.com`, a path under `/v1.0/` or `/beta/`, and — since this is
 * feasible without restructuring the caller, which already knows the mapping's own request path — that the
 * resource path matches the mapping's own request path (the cursor may only add a query string). The path match is
 * case-insensitive because Graph resource paths are, and Graph may re-case them in `@odata.nextLink`.
 *
 * Returns the parsed `url.href`, not the raw input, so the value followed is exactly the value validated.
 */
export function assertValidGraphCursorUrl(decoded: string, requestPath: string): string {
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new GatewayError('INVALID_INPUT', 'Invalid cursor', 400);
  }
  if (url.origin !== GRAPH_ORIGIN) {
    throw new GatewayError('INVALID_INPUT', 'Invalid cursor', 400);
  }
  const versionMatch = /^\/(v1\.0|beta)(\/.*)?$/.exec(url.pathname);
  if (!versionMatch) {
    throw new GatewayError('INVALID_INPUT', 'Invalid cursor', 400);
  }
  const resourcePath = (versionMatch[2] ?? '/').replace(/\/+$/, '') || '/';
  const expectedPath = requestPath.replace(/\/+$/, '') || '/';
  if (resourcePath.toLowerCase() !== expectedPath.toLowerCase()) {
    throw new GatewayError('INVALID_INPUT', 'Invalid cursor', 400);
  }
  return url.href;
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
