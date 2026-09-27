import { GatewayError } from '../../gateway/errors';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';

export interface NormalizedRequestQuery {
  select?: string;
  filter?: string;
  expand?: string;
  limit?: number;
  cursor?: string;
}

export function normalizeRequestQuery(query?: Record<string, unknown>): NormalizedRequestQuery {
  if (!query) return {};
  const normalized: NormalizedRequestQuery = {};
  for (const name of ['select', 'filter', 'expand', 'cursor'] as const) {
    const value = query[name];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string') {
      throw new GatewayError('INVALID_INPUT', `"${name}" must be a single string`, 400);
    }
    normalized[name] = value;
  }
  if (query.limit !== undefined && query.limit !== '') {
    if (typeof query.limit !== 'string') {
      throw new GatewayError('INVALID_INPUT', '"limit" must be a positive integer', 400);
    }
    const parsed = Number(query.limit);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new GatewayError('INVALID_INPUT', '"limit" must be a positive integer', 400);
    }
    normalized.limit = parsed;
  }
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
 * case-insensitive because Graph resource paths are, and Graph may re-case them in `@odata.nextLink`. It also ignores
 * percent-encoding differences within a segment (`alice%40contoso.com` vs `alice@contoso.com`), comparing segment by
 * segment so a decoded `%2F` can never turn one segment into two.
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
  const versionMatch = /^\/(v1\.0|beta)(\/.*)?$/i.exec(url.pathname);
  if (!versionMatch) {
    throw new GatewayError('INVALID_INPUT', 'Invalid cursor', 400);
  }
  const resourcePath = (versionMatch[2] ?? '/').replace(/\/+$/, '') || '/';
  const expectedPath = requestPath.replace(/\/+$/, '') || '/';
  if (canonicalPath(resourcePath) !== canonicalPath(expectedPath)) {
    throw new GatewayError('INVALID_INPUT', 'Invalid cursor', 400);
  }
  return url.href;
}

/** Lower-cases a path and re-encodes each segment in one canonical form, so only the spelling of a segment varies. */
function canonicalPath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment)).toLowerCase();
      } catch {
        return segment.toLowerCase();
      }
    })
    .join('/');
}

export function interpolatePath(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for template "${template}"`);
    }
    // encodeURIComponent leaves "." alone, and URL resolution would turn /users/.. into a different Graph resource.
    if (value === '.' || value === '..') {
      throw new GatewayError('INVALID_INPUT', `Path parameter "${name}" must not be "." or ".."`, 400);
    }
    return encodeURIComponent(value);
  });
}
