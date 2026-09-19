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
});
