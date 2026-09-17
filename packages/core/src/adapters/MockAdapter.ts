import type { Adapter, AuthContext, MappingDraft } from './Adapter';

export class MockAdapter implements Adapter {
  readonly type = 'mock';

  async introspect(_authContext: AuthContext): Promise<unknown> {
    return { types: [{ name: 'user', fields: ['id', 'displayName', 'mail'] }] };
  }

  async generateMappings(_introspection: unknown): Promise<MappingDraft[]> {
    return [
      {
        route: '/users/{id}',
        method: 'GET',
        operation: {
          query: 'user(id: $id) { id, displayName, mail }',
          variables: { id: '$params.id' },
        },
        responseTemplate: { id: '$.id', name: '$.displayName', email: '$.mail' },
      },
    ];
  }

  async execute(
    _operation: Record<string, unknown>,
    params: Record<string, string>,
    _authContext: AuthContext
  ): Promise<unknown> {
    return { id: params.id, displayName: 'Mock User', mail: 'mock@example.com' };
  }
}
