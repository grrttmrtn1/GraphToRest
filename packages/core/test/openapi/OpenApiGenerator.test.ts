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
});
