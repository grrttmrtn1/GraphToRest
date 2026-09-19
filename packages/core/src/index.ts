export type { Adapter, AuthContext, MappingDraft, RequestContext } from './adapters/Adapter';
export { registerAdapter, createAdapter, listAdapterTypes, clearAdapters } from './adapters/registry';
export { MockAdapter } from './adapters/MockAdapter';
export { MicrosoftGraphAdapter } from './adapters/microsoftGraph/MicrosoftGraphAdapter';
export { GraphQLAdapter } from './adapters/graphql/GraphQLAdapter';
export { registerDefaultAdapters } from './adapters/defaults';

export { openDb } from './storage/db';
export { MappingStore } from './storage/MappingStore';
export type { ConnectionRecord, MappingRecord, ApiKeyRecord } from './storage/MappingStore';

export { generateApiKey, hashSecret, verifySecret, parsePresentedKey } from './auth/apiKeys';
export type { GeneratedApiKey } from './auth/apiKeys';

export { matchRoute } from './gateway/matchRoute';
export { GatewayEngine } from './gateway/GatewayEngine';
export type { ResolvedRequest } from './gateway/GatewayEngine';
export { GatewayError, toErrorResponse } from './gateway/errors';
export type { ErrorResponse } from './gateway/errors';

export { OpenApiGenerator } from './openapi/OpenApiGenerator';
export { generateAndPersistMappings } from './mappingEngine/generateMappings';
export type { GenerationResult } from './mappingEngine/generateMappings';
export { mappingToYamlEntry, yamlEntryToMappingInput } from './mappingEngine/yamlTransform';
export { parseRouteString } from './mappingEngine/routeString';
export type { MappingYamlEntry, MappingInput } from './mappingEngine/yamlTransform';
