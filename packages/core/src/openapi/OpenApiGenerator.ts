import type { MappingRecord } from '../storage/MappingStore';

const LIST_QUERY_PARAMS = ['select', 'filter', 'expand', 'limit', 'cursor'];
const GET_QUERY_PARAMS = ['select', 'expand'];

export class OpenApiGenerator {
  generate(mappings: MappingRecord[]): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const mapping of mappings) {
      const pathItem = paths[mapping.route] ?? (paths[mapping.route] = {});
      const paramNames = [...mapping.route.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      const pathParameters = paramNames.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
      const queryParameters = queryParamsFor(mapping).map((name) => ({
        name,
        in: 'query',
        required: false,
        schema: { type: 'string' },
      }));
      pathItem[mapping.method.toLowerCase()] = {
        operationId: `${mapping.method.toLowerCase()}_${mapping.route.replace(/[/{}]/g, '_')}`,
        parameters: [...pathParameters, ...queryParameters],
        responses: {
          '200': {
            description: 'Successful response',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      };
    }
    return {
      openapi: '3.0.3',
      info: { title: 'GraphToRest API', version: '1.0.0' },
      paths,
    };
  }
}

function queryParamsFor(mapping: MappingRecord): string[] {
  const kind = (mapping.operation as { kind?: string } | null)?.kind;
  if (kind === 'list') return LIST_QUERY_PARAMS;
  if (kind === 'get') return GET_QUERY_PARAMS;
  return [];
}
