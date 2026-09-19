import { describe, it, expect } from 'vitest';
import { mappingToYamlEntry, yamlEntryToMappingInput } from '../../src/mappingEngine/yamlTransform';
import type { MappingRecord } from '../../src/storage/MappingStore';

describe('mappingToYamlEntry', () => {
  it('serializes a mapping with a response template', () => {
    const mapping: MappingRecord = {
      id: 'm1',
      connectionId: 'c1',
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id) { id }' },
      responseTemplate: { id: '$.id' },
      source: 'generated',
    };
    expect(mappingToYamlEntry(mapping, 'ms-graph-prod')).toEqual({
      id: 'm1',
      route: 'GET /users/{id}',
      connection: 'ms-graph-prod',
      source: 'generated',
      operation: { query: 'user(id: $id) { id }' },
      response: { shape: 'template', template: { id: '$.id' } },
      auth: 'inherit',
    });
  });

  it('serializes a mapping with no response template as passthrough', () => {
    const mapping: MappingRecord = {
      id: 'm2',
      connectionId: 'c1',
      route: '/count',
      method: 'GET',
      operation: { query: 'count' },
      responseTemplate: null,
      source: 'manual',
    };
    expect(mappingToYamlEntry(mapping, 'c1').response).toEqual({ shape: 'passthrough' });
  });
});

describe('yamlEntryToMappingInput', () => {
  it('parses a template-shaped entry back into a mapping input', () => {
    const input = yamlEntryToMappingInput(
      {
        id: 'm1',
        route: 'GET /users/{id}',
        connection: 'ms-graph-prod',
        source: 'generated',
        operation: { query: 'user(id: $id) { id }' },
        response: { shape: 'template', template: { id: '$.id' } },
        auth: 'inherit',
      },
      'c1'
    );
    expect(input).toEqual({
      id: 'm1',
      connectionId: 'c1',
      route: '/users/{id}',
      method: 'GET',
      operation: { query: 'user(id: $id) { id }' },
      responseTemplate: { id: '$.id' },
    });
  });

  it('parses a passthrough-shaped entry with a null response template', () => {
    const input = yamlEntryToMappingInput(
      {
        route: 'GET /count',
        connection: 'c1',
        source: 'manual',
        operation: { query: 'count' },
        response: { shape: 'passthrough' },
        auth: 'inherit',
      },
      'c1'
    );
    expect(input.responseTemplate).toBeNull();
    expect(input.id).toBeUndefined();
  });

  it('throws for an unsupported auth mode', () => {
    expect(() =>
      yamlEntryToMappingInput(
        { route: 'GET /x', connection: 'c1', source: 'manual', operation: {}, response: { shape: 'passthrough' }, auth: 'override' },
        'c1'
      )
    ).toThrow(/override/);
  });

  it('throws for a route string missing the HTTP method', () => {
    expect(() =>
      yamlEntryToMappingInput(
        { route: '/users/{id}', connection: 'c1', source: 'manual', operation: {}, response: { shape: 'passthrough' }, auth: 'inherit' },
        'c1'
      )
    ).toThrow(/\/users\/\{id\}/);
  });

  it('throws for a route string missing the path', () => {
    expect(() =>
      yamlEntryToMappingInput(
        { route: 'GET', connection: 'c1', source: 'manual', operation: {}, response: { shape: 'passthrough' }, auth: 'inherit' },
        'c1'
      )
    ).toThrow(/GET/);
  });
  const base = {
    route: 'GET /x',
    connection: 'c1',
    source: 'manual' as const,
    operation: {},
    response: { shape: 'passthrough' as const },
    auth: 'inherit',
  };

  it('rejects an entry with a missing or non-object operation', () => {
    expect(() => yamlEntryToMappingInput({ ...base, operation: undefined as never }, 'c1')).toThrow(/operation/);
    expect(() => yamlEntryToMappingInput({ ...base, operation: 'hi' as never }, 'c1')).toThrow(/operation/);
    expect(() => yamlEntryToMappingInput({ ...base, operation: [] as never }, 'c1')).toThrow(/operation/);
  });

  it('rejects an entry with a missing or unknown response shape', () => {
    expect(() => yamlEntryToMappingInput({ ...base, response: undefined as never }, 'c1')).toThrow(/response/);
    expect(() => yamlEntryToMappingInput({ ...base, response: { shape: 'weird' } as never }, 'c1')).toThrow(/response/);
  });

  it('rejects a template response without a string-to-string template map', () => {
    expect(() => yamlEntryToMappingInput({ ...base, response: { shape: 'template' } }, 'c1')).toThrow(/template/);
    expect(() => yamlEntryToMappingInput({ ...base, response: { shape: 'template', template: { a: 1 } as never } }, 'c1')).toThrow(/template/);
  });
});
