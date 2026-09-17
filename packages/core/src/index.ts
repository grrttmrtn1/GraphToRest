export type { Adapter, AuthContext, MappingDraft } from './adapters/Adapter';
export { registerAdapter, createAdapter } from './adapters/registry';
export { MockAdapter } from './adapters/MockAdapter';
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
