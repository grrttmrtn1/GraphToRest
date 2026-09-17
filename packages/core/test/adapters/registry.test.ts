import { describe, it, expect, beforeEach } from 'vitest';
import { registerAdapter, createAdapter } from '../../src/adapters/registry';
import type { Adapter, AuthContext, MappingDraft } from '../../src/adapters/Adapter';

class FakeAdapter implements Adapter {
  readonly type = 'fake';
  async introspect(_ctx: AuthContext): Promise<unknown> { return {}; }
  async generateMappings(_i: unknown): Promise<MappingDraft[]> { return []; }
  async execute(): Promise<unknown> { return { ok: true }; }
}

describe('adapter registry', () => {
  beforeEach(() => {
    registerAdapter('fake', () => new FakeAdapter());
  });

  it('creates a registered adapter by type', () => {
    const adapter = createAdapter('fake');
    expect(adapter.type).toBe('fake');
  });

  it('throws for an unregistered type', () => {
    expect(() => createAdapter('nonexistent')).toThrow('Unknown adapter type: nonexistent');
  });
});
