import { GatewayError } from './errors';

export function isParamSegment(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

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
    if (isParamSegment(patternSegment)) {
      params[patternSegment.slice(1, -1)] = decodeSegment(actualSegment);
    } else if (patternSegment !== actualSegment) {
      return null;
    }
  }
  return params;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new GatewayError('INVALID_INPUT', 'The request path contains malformed percent-encoding', 400);
  }
}
