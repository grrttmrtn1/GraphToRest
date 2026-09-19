import { describe, it, expect } from 'vitest';
import { parseMappingFields } from '../../src/mappingEngine/mappingFields';

describe('parseMappingFields', () => {
  it('returns only the keys that were provided and upper-cases the method', () => {
    expect(parseMappingFields({ method: 'get', operation: { a: 1 } })).toEqual({ method: 'GET', operation: { a: 1 } });
    expect(parseMappingFields({})).toEqual({});
  });

  it('preserves an explicit null responseTemplate and accepts a string map', () => {
    expect(parseMappingFields({ responseTemplate: null })).toEqual({ responseTemplate: null });
    expect(parseMappingFields({ responseTemplate: { id: '$.id' } })).toEqual({ responseTemplate: { id: '$.id' } });
  });

  it.each([
    [{ route: 'no-slash' }, /route/],
    [{ route: '/has space' }, /route/],
    [{ route: 5 }, /route/],
    [{ method: 'G3T' }, /method/],
    [{ method: 5 }, /method/],
    [{ operation: [] }, /operation/],
    [{ operation: 'x' }, /operation/],
    [{ operation: null }, /operation/],
    [{ responseTemplate: [] }, /responseTemplate/],
    [{ responseTemplate: { id: 5 } }, /responseTemplate/],
    [{ responseTemplate: 'x' }, /responseTemplate/],
    [{ source: 'other' }, /source/],
  ])('rejects %j', (input, message) => {
    expect(() => parseMappingFields(input as Record<string, unknown>)).toThrow(message);
    try {
      parseMappingFields(input as Record<string, unknown>);
    } catch (err) {
      expect(err).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    }
  });

  it('accepts a valid source', () => {
    expect(parseMappingFields({ source: 'manual' })).toEqual({ source: 'manual' });
  });
});
