export function parseRouteString(combined: string): { method: string; route: string } {
  const parts = combined.trim().split(/\s+/);
  const [method, ...rest] = parts;
  if (rest.length !== 1 || !rest[0].startsWith('/')) {
    throw new Error(`Malformed route "${combined}" — expected "METHOD /path"`);
  }
  return { method: method.toUpperCase(), route: rest[0] };
}
