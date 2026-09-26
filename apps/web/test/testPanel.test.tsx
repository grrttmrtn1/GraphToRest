import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';
import { withApiKey, readTestApiKey, storeTestApiKey } from '../src/testApiKey';

vi.mock('../src/pages/SwaggerPanel', () => ({ default: ({ apiKey }: { apiKey: string }) => <div>swagger-panel key={apiKey}</div> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('withApiKey', () => {
  it('adds a bearer header and keeps existing headers', () => {
    expect(withApiKey({ url: '/api/x', headers: { Accept: 'application/json' } }, 'k.s')).toEqual({
      url: '/api/x',
      headers: { Accept: 'application/json', Authorization: 'Bearer k.s' },
    });
  });

  it('leaves the request alone without a key', () => {
    // Typed explicitly (rather than inferred as `{ url: string }`) so it shares the `headers`
    // property with withApiKey's constraint; otherwise TS's weak-type detection (all-optional
    // target properties) rejects the call even though it's valid at runtime.
    const request: { url: string; headers?: Record<string, string> } = { url: '/api/x' };
    expect(withApiKey(request, '')).toBe(request);
  });
});

describe('test API key storage', () => {
  it('round-trips through sessionStorage and clears on empty', () => {
    storeTestApiKey('k.s');
    expect(readTestApiKey()).toBe('k.s');
    storeTestApiKey('');
    expect(sessionStorage.getItem('gtr_test_api_key')).toBeNull();
  });
});

describe('test panel page', () => {
  it('pre-fills the stored key and passes edits to the Swagger panel', async () => {
    sessionStorage.setItem('gtr_test_api_key', 'stored.key');
    mockFetch([SESSION_ROUTE]);
    renderApp('/test');
    const input = (await screen.findByLabelText('API key')) as HTMLInputElement;
    expect(screen.getByText(/explorer is generated automatically from your endpoints/)).toBeTruthy();
    expect(input.value).toBe('stored.key');
    expect(await screen.findByText('swagger-panel key=stored.key')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'new.key' } });
    expect(await screen.findByText('swagger-panel key=new.key')).toBeTruthy();
    expect(sessionStorage.getItem('gtr_test_api_key')).toBe('new.key');
  });
});
