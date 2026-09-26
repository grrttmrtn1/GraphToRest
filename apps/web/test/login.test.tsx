import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderApp, mockFetch, SESSION_ROUTE, type MockRoute } from './render';

const UNAUTHORIZED = { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Admin login required', details: {} } } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fillLogin(username: string, password: string) {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
}

describe('login', () => {
  it('sends an unauthenticated visitor to the login page, then back to where they were going', async () => {
    const { calls } = mockFetch([
      { path: '/admin/session', ...UNAUTHORIZED },
      { method: 'POST', path: '/admin/login', body: { username: 'admin', expiresAt: '2099-01-01T00:00:00.000Z' } },
    ]);
    renderApp('/activity');
    expect(await screen.findByRole('heading', { name: 'GraphToRest' })).toBeTruthy();
    expect(screen.getByText(/gtr admin create/)).toBeTruthy();

    fillLogin('admin', 'correct-horse-battery');

    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeTruthy();
    expect(calls.find((c) => c.path === '/admin/login')!.body).toEqual({
      username: 'admin',
      password: 'correct-horse-battery',
      session: 'cookie',
    });
    expect(screen.getByText('admin')).toBeTruthy();
  });

  it('shows the server message on a failed login', async () => {
    mockFetch([
      { path: '/admin/session', ...UNAUTHORIZED },
      { method: 'POST', path: '/admin/login', status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid username or password', details: {} } } },
    ]);
    renderApp('/connections');
    await screen.findByLabelText('Username');
    fillLogin('admin', 'wrong-password-123');
    expect(await screen.findByText('Invalid username or password')).toBeTruthy();
  });

  it('lets a signed-in admin log out', async () => {
    const { calls } = mockFetch([SESSION_ROUTE, { method: 'POST', path: '/admin/logout', status: 204 }]);
    renderApp('/connections');
    fireEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByLabelText('Username')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/admin/logout')).toBe(true);
  });

  it('sends an admin whose session expires mid-use to the login page, then back to the same page', async () => {
    // The session check passes, but the page's own data call hits a session that expired server-side.
    const apiKeys: MockRoute = { path: '/admin/api-keys', ...UNAUTHORIZED };
    const { calls } = mockFetch([
      SESSION_ROUTE,
      apiKeys,
      { method: 'POST', path: '/admin/login', body: { username: 'admin', expiresAt: '2099-01-01T00:00:00.000Z' } },
    ]);
    renderApp('/api-keys');
    expect(await screen.findByLabelText('Username')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'API keys' })).toBeNull();

    Object.assign(apiKeys, { status: 200, body: [] });
    fillLogin('admin', 'correct-horse-battery');

    expect(await screen.findByText('No API keys yet.')).toBeTruthy();
    expect(calls.filter((c) => c.path === '/admin/api-keys')).toHaveLength(2);
  });

  it('shows an error panel when the session check fails for another reason', async () => {
    mockFetch([{ path: '/admin/session', status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} } } }]);
    renderApp('/connections');
    expect(await screen.findByText('Internal server error')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
