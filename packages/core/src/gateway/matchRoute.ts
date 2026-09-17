export function matchRoute(pattern: string, actualPath: string): Record<string, string> | null {
  const patternSegments = pattern.split('/').filter(Boolean);
  const actualSegments = actualPath.split('/').filter(Boolean);
  if (patternSegments.length !== actualSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i];
    const actualSegment = actualSegments[i];
    if (patternSegment.startsWith('{') && patternSegment.endsWith('}')) {
      params[patternSegment.slice(1, -1)] = decodeURIComponent(actualSegment);
    } else if (patternSegment !== actualSegment) {
      return null;
    }
  }
  return params;
}
