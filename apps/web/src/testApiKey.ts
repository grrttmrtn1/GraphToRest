export const TEST_API_KEY_STORAGE = 'gtr_test_api_key';

/** The test panel's API key lives in sessionStorage: it survives reloads of this tab only. Storage may be unavailable. */
export function readTestApiKey(): string {
  try {
    return sessionStorage.getItem(TEST_API_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function storeTestApiKey(key: string): void {
  try {
    if (key) sessionStorage.setItem(TEST_API_KEY_STORAGE, key);
    else sessionStorage.removeItem(TEST_API_KEY_STORAGE);
  } catch {
    // storage unavailable (private mode, blocked site data): the key just won't persist
  }
}

export function withApiKey<T extends { headers?: Record<string, string> }>(request: T, key: string): T {
  if (!key) return request;
  return { ...request, headers: { ...(request.headers ?? {}), Authorization: `Bearer ${key}` } };
}
