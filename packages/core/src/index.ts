export type { Adapter, AuthContext, MappingDraft, RequestContext } from './adapters/Adapter';
export { registerAdapter, createAdapter, listAdapterTypes, clearAdapters } from './adapters/registry';
export { MockAdapter } from './adapters/MockAdapter';
export { MicrosoftGraphAdapter } from './adapters/microsoftGraph/MicrosoftGraphAdapter';
export { GraphQLAdapter } from './adapters/graphql/GraphQLAdapter';
export { registerDefaultAdapters } from './adapters/defaults';

export { openDb } from './storage/db';
export { MappingStore } from './storage/MappingStore';
export type {
  ConnectionRecord,
  MappingRecord,
  ApiKeyRecord,
  AdminUserRecord,
  ApiKeySummary,
  RequestLogInput,
  RequestLogRecord,
} from './storage/MappingStore';

export { generateApiKey, hashSecret, verifySecret, parsePresentedKey } from './auth/apiKeys';
export type { GeneratedApiKey } from './auth/apiKeys';

export { loginAdmin, DEFAULT_ADMIN_SESSION_TTL_MS } from './auth/adminAuth';

export { CredentialCipher } from './auth/credentialCipher';

export { matchRoute } from './gateway/matchRoute';
export { GatewayEngine } from './gateway/GatewayEngine';
export type { ResolvedRequest, GatewayHooks } from './gateway/GatewayEngine';
export { GatewayError, toErrorResponse } from './gateway/errors';
export type { ErrorResponse } from './gateway/errors';

export { OpenApiGenerator } from './openapi/OpenApiGenerator';
export { generateAndPersistMappings } from './mappingEngine/generateMappings';
export type { GenerationResult } from './mappingEngine/generateMappings';
export { mappingToYamlEntry, yamlEntryToMappingInput } from './mappingEngine/yamlTransform';
export { exportMappingsYaml, importMappingsYaml } from './mappingEngine/mappingYaml';
export type { MappingYamlEntry, MappingInput } from './mappingEngine/yamlTransform';
export type { MappingImportResult } from './mappingEngine/mappingYaml';
export { parseRouteString } from './mappingEngine/routeString';
export { parseMappingFields } from './mappingEngine/mappingFields';
export type { MappingFields } from './mappingEngine/mappingFields';
export { parseManagedCredentials } from './auth/oauthClient';
export type { ManagedCredentials, OAuthGrant } from './auth/oauthClient';
export { ManagedTokenService, connectionIdFromAuthorizationError } from './auth/managedTokenService';
export type { AccessTokenProvider, CredentialStatus, AuthorizationCallbackError } from './auth/managedTokenService';
export { buildAuthContext } from './auth/authContext';

export { createLogger, silentLogger } from './logging/logger';
export type { Logger, LogLevel, LogFields, LoggerOptions } from './logging/logger';

export { isPrivateAddress } from './net/ipRanges';
export {
  getOutboundPolicy,
  setOutboundPolicy,
  resetOutboundPolicy,
  outboundPolicyFromEnv,
  systemLookup,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
} from './net/outboundPolicy';
export type { OutboundPolicy, LookupFn } from './net/outboundPolicy';
export { assertOutboundUrlShape, assertOutboundTargetAllowed, outboundFetch } from './net/outboundUrl';
