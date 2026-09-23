import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE } from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function row(id: number, path: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ts: '2026-09-22T10:00:00.000Z',
    method: 'GET',
    path,
    status: 200,
    durationMs: 12,
    errorCode: null,
    apiKeyId: 'k1',
    apiKeyLabel: 'dev',
    connectionId: 'c1',
    connectionName: 'mock-conn',
    mappingId: 'm1',
    ...extra,
  };
}

describe('activity page', () => {
  it('shows rows and loads older pages', async () => {
    const { calls } = mockFetch([
      SESSION_ROUTE,
      { path: '/admin/activity?limit=50', body: { items: [row(3, '/api/three'), row(2, '/api/two', { status: 404, errorCode: 'NOT_FOUND', mappingId: null, connectionName: null })], nextBefore: 2 } },
      { path: '/admin/activity?limit=50&before=2', body: { items: [row(1, '/api/one')], nextBefore: null } },
    ]);
    renderApp('/activity');
    expect(await screen.findByText('/api/three')).toBeTruthy();
    expect(screen.getByText('NOT_FOUND')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('/api/one')).toBeTruthy();
    expect(calls.some((c) => c.path === '/admin/activity?limit=50&before=2')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
  });

  it('shows an empty state', async () => {
    mockFetch([SESSION_ROUTE, { path: '/admin/activity?limit=50', body: { items: [], nextBefore: null } }]);
    renderApp('/activity');
    expect(await screen.findByText('No requests recorded yet.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
  });
});
