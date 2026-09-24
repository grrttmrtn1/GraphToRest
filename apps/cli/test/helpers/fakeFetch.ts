export interface FakeCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  /** Defaults to application/json when body is set. */
  contentType?: string;
}

type Responder = FakeResponse | ((call: FakeCall) => FakeResponse);

/** Routes are keyed "METHOD /pathname" (no query string). Unrouted calls fail the test loudly. */
export function fakeFetch(routes: Record<string, Responder>) {
  const calls: FakeCall[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call: FakeCall = {
      method: (init.method ?? 'GET').toUpperCase(),
      url: url.toString(),
      path: url.pathname,
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const responder = routes[`${call.method} ${call.path}`];
    if (!responder) throw new Error(`fakeFetch: no route for ${call.method} ${call.path}`);
    const response = typeof responder === 'function' ? responder(call) : responder;
    if (response.status === 204) return new Response(null, { status: 204 });
    const isText = typeof response.body === 'string';
    const contentType = response.contentType ?? (isText ? 'text/plain' : 'application/json; charset=utf-8');
    const payload = response.body === undefined ? '' : isText ? (response.body as string) : JSON.stringify(response.body);
    return new Response(payload, { status: response.status, headers: { 'content-type': contentType } });
  }) as typeof fetch;
  return { impl, calls };
}
