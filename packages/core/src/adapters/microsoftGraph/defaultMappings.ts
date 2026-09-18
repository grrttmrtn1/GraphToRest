import type { MappingDraft } from '../Adapter';

export const DEFAULT_MICROSOFT_GRAPH_MAPPINGS: MappingDraft[] = [
  {
    route: '/msgraph/users',
    method: 'GET',
    operation: { kind: 'list', path: '/users' },
  },
  {
    route: '/msgraph/users/{id}',
    method: 'GET',
    operation: { kind: 'get', path: '/users/{id}' },
    responseTemplate: { id: '$.id', displayName: '$.displayName', mail: '$.mail' },
  },
  {
    route: '/msgraph/users/{id}/overview',
    method: 'GET',
    operation: {
      kind: 'batch',
      requests: [
        { id: 'user', method: 'GET', path: '/users/{id}' },
        { id: 'manager', method: 'GET', path: '/users/{id}/manager' },
      ],
    },
    responseTemplate: {
      id: '$.user.id',
      displayName: '$.user.displayName',
      mail: '$.user.mail',
      managerId: '$.manager.id',
      managerDisplayName: '$.manager.displayName',
    },
  },
  {
    route: '/msgraph/users/delta',
    method: 'GET',
    operation: { kind: 'list', path: '/users/delta' },
  },
  {
    route: '/msgraph/groups',
    method: 'GET',
    operation: { kind: 'list', path: '/groups' },
  },
  {
    route: '/msgraph/groups/{id}',
    method: 'GET',
    operation: { kind: 'get', path: '/groups/{id}' },
    responseTemplate: { id: '$.id', displayName: '$.displayName' },
  },
  {
    route: '/msgraph/me/messages',
    method: 'GET',
    operation: { kind: 'list', path: '/me/messages' },
  },
  {
    route: '/msgraph/me/events',
    method: 'GET',
    operation: { kind: 'list', path: '/me/events' },
  },
  {
    route: '/msgraph/me/drive/root/children',
    method: 'GET',
    operation: { kind: 'list', path: '/me/drive/root/children' },
  },
  {
    route: '/msgraph/me/joinedTeams',
    method: 'GET',
    operation: { kind: 'list', path: '/me/joinedTeams' },
  },
];
