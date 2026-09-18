import { describe, it, expect } from 'vitest';
import { DEFAULT_MICROSOFT_GRAPH_MAPPINGS } from '../../../src/adapters/microsoftGraph/defaultMappings';

describe('DEFAULT_MICROSOFT_GRAPH_MAPPINGS', () => {
  it('covers users, groups, mail, calendar, drive, and teams under the /msgraph namespace', () => {
    const routes = DEFAULT_MICROSOFT_GRAPH_MAPPINGS.map((m) => `${m.method} ${m.route}`);
    expect(routes).toEqual([
      'GET /msgraph/users',
      'GET /msgraph/users/{id}',
      'GET /msgraph/users/{id}/overview',
      'GET /msgraph/users/delta',
      'GET /msgraph/groups',
      'GET /msgraph/groups/{id}',
      'GET /msgraph/me/messages',
      'GET /msgraph/me/events',
      'GET /msgraph/me/drive/root/children',
      'GET /msgraph/me/joinedTeams',
    ]);
  });

  it('gives every mapping a recognized operation kind', () => {
    for (const mapping of DEFAULT_MICROSOFT_GRAPH_MAPPINGS) {
      expect(['get', 'list', 'batch']).toContain((mapping.operation as { kind: string }).kind);
    }
  });

  it('defines the overview route as a batch of a user and their manager', () => {
    const overview = DEFAULT_MICROSOFT_GRAPH_MAPPINGS.find((m) => m.route === '/msgraph/users/{id}/overview')!;
    expect(overview.operation).toEqual({
      kind: 'batch',
      requests: [
        { id: 'user', method: 'GET', path: '/users/{id}' },
        { id: 'manager', method: 'GET', path: '/users/{id}/manager' },
      ],
    });
    expect(overview.responseTemplate).toEqual({
      id: '$.user.id',
      displayName: '$.user.displayName',
      mail: '$.user.mail',
      managerId: '$.manager.id',
      managerDisplayName: '$.manager.displayName',
    });
  });

  it('defines the single-user route as a get with a passthrough-shaped response template', () => {
    const user = DEFAULT_MICROSOFT_GRAPH_MAPPINGS.find((m) => m.route === '/msgraph/users/{id}')!;
    expect(user.operation).toEqual({ kind: 'get', path: '/users/{id}' });
    expect(user.responseTemplate).toEqual({ id: '$.id', displayName: '$.displayName', mail: '$.mail' });
  });

  it('leaves list-route response templates null so the adapter\'s pagination envelope passes through', () => {
    const users = DEFAULT_MICROSOFT_GRAPH_MAPPINGS.find((m) => m.route === '/msgraph/users')!;
    expect(users.operation).toEqual({ kind: 'list', path: '/users' });
    expect(users.responseTemplate ?? null).toBeNull();
  });

  it('exposes the delta route as a list operation over /users/delta', () => {
    const delta = DEFAULT_MICROSOFT_GRAPH_MAPPINGS.find((m) => m.route === '/msgraph/users/delta')!;
    expect(delta.operation).toEqual({ kind: 'list', path: '/users/delta' });
  });
});
