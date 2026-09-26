import { describe, it, expect } from 'vitest';
import { OpenApiGenerator } from '../../src/openapi/OpenApiGenerator';
import type { MappingRecord } from '../../src/storage/MappingStore';

const mapping: MappingRecord = {
  id: 'm1',
  connectionId: 'c1',
  route: '/users/{id}',
  method: 'GET',
  operation: {},
  responseTemplate: { id: '$.id', name: '$.displayName' },
  source: 'generated',
};

describe('OpenApiGenerator', () => {
  const generator = new OpenApiGenerator();

  it('produces a valid OpenAPI 3 envelope', () => {
    const doc = generator.generate([mapping]) as any;
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.title).toBe('GraphToRest API');
  });

  it('declares /api as the server so "Try it out" requests reach the gateway, not the web UI', () => {
    const doc = generator.generate([mapping]) as any;
    expect(doc.servers).toEqual([{ url: '/api' }]);
  });

  it('adds a path item keyed by the route with a lowercase method', () => {
    const doc = generator.generate([mapping]) as any;
    expect(doc.paths['/users/{id}'].get).toBeDefined();
  });

  it('declares path parameters extracted from the route', () => {
    const doc = generator.generate([mapping]) as any;
    expect(doc.paths['/users/{id}'].get.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('declares a 200 JSON response', () => {
    const doc = generator.generate([mapping]) as any;
    expect(doc.paths['/users/{id}'].get.responses['200'].content['application/json']).toBeDefined();
  });

  it('returns an empty paths object for no mappings', () => {
    const doc = generator.generate([]) as any;
    expect(doc.paths).toEqual({});
  });

  it('declares select/filter/expand/limit/cursor query params for a "list" operation kind', () => {
    const listMapping: MappingRecord = {
      id: 'm2',
      connectionId: 'c1',
      route: '/msgraph/users',
      method: 'GET',
      operation: { kind: 'list', path: '/users' },
      responseTemplate: null,
      source: 'generated',
    };
    const doc = generator.generate([listMapping]) as any;
    const queryParams = doc.paths['/msgraph/users'].get.parameters.filter((p: any) => p.in === 'query');
    expect(queryParams.map((p: any) => p.name)).toEqual(['select', 'filter', 'expand', 'limit', 'cursor']);
    expect(queryParams.every((p: any) => p.required === false && p.schema.type === 'string')).toBe(true);
  });

  it('declares select/expand query params for a "get" operation kind', () => {
    const getMapping: MappingRecord = {
      id: 'm3',
      connectionId: 'c1',
      route: '/msgraph/users/{id}',
      method: 'GET',
      operation: { kind: 'get', path: '/users/{id}' },
      responseTemplate: null,
      source: 'generated',
    };
    const doc = generator.generate([getMapping]) as any;
    const queryParams = doc.paths['/msgraph/users/{id}'].get.parameters.filter((p: any) => p.in === 'query');
    expect(queryParams.map((p: any) => p.name)).toEqual(['select', 'expand']);
  });
});
