import type { MappingRecord } from '../storage/MappingStore';

export class OpenApiGenerator {
  generate(mappings: MappingRecord[]): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const mapping of mappings) {
      const pathItem = paths[mapping.route] ?? (paths[mapping.route] = {});
      const paramNames = [...mapping.route.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      pathItem[mapping.method.toLowerCase()] = {
        operationId: `${mapping.method.toLowerCase()}_${mapping.route.replace(/[/{}]/g, '_')}`,
        parameters: paramNames.map((name) => ({
          name,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        })),
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
