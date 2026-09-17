import { describe, it, expect } from 'vitest';
import { MockAdapter } from '../../src/adapters/MockAdapter';

describe('MockAdapter', () => {
  const adapter = new MockAdapter();

  it('has type "mock"', () => {
    expect(adapter.type).toBe('mock');
  });

  it('generates the canonical GET /users/{id} mapping', async () => {
    const drafts = await adapter.generateMappings(await adapter.introspect({ connectionId: 'c1' }));
    expect(drafts).toEqual([
      {
        route: '/users/{id}',
        method: 'GET',
        operation: {
          query: 'user(id: $id) { id, displayName, mail }',
          variables: { id: '$params.id' },
        },
        responseTemplate: { id: '$.id', name: '$.displayName', email: '$.mail' },
      },
    ]);
  });

  it('executes and returns a canned user shaped by the requested id', async () => {
    const result = await adapter.execute({}, { id: '42' }, { connectionId: 'c1' });
    expect(result).toEqual({ id: '42', displayName: 'Mock User', mail: 'mock@example.com' });
  });
});
