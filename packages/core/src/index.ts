export type { Adapter, AuthContext, MappingDraft, RequestContext } from './adapters/Adapter';
export { registerAdapter, createAdapter, listAdapterTypes, clearAdapters } from './adapters/registry';
export { MockAdapter } from './adapters/MockAdapter';
export { MicrosoftGraphAdapter } from './adapters/microsoftGraph/MicrosoftGraphAdapter';
export { GraphQLAdapter } from './adapters/graphql/GraphQLAdapter';
export { registerDefaultAdapters } from './adapters/defaults';
export { parseConnectionConfig } from './adapters/connectionConfig';

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

export { generateApiKey, hashSecret, verifySecret, parsePresentedKey, DUMMY_SECRET_HASH } from './auth/apiKeys';
export type { GeneratedApiKey } from './auth/apiKeys';

export { loginAdmin, DEFAULT_ADMIN_SESSION_TTL_MS, MAX_PASSWORD_LENGTH } from './auth/adminAuth';

export { CredentialCipher } from './auth/credentialCipher';

export { matchRoute } from './gateway/matchRoute';
export { GatewayEngine } from './gateway/GatewayEngine';
export type { ResolvedRequest, GatewayHooks } from './gateway/GatewayEngine';
export { GatewayError, toErrorResponse } from './gateway/errors';
export type { ErrorResponse } from './gateway/errors';
export { redactVendorText, REDACTED } from './gateway/redact';

export { OpenApiGenerator } from './openapi/OpenApiGenerator';
export { generateAndPersistMappings } from './mappingEngine/generateMappings';
export type { GenerationResult } from './mappingEngine/generateMappings';
export { mappingToYamlEntry, yamlEntryToMappingInput } from './mappingEngine/yamlTransform';
export { exportMappingsYaml, importMappingsYaml } from './mappingEngine/mappingYaml';
export type { MappingYamlEntry, MappingInput } from './mappingEngine/yamlTransform';
export type { MappingImportResult } from './mappingEngine/mappingYaml';
export { parseRouteString } from './mappingEngine/routeString';
export { parseMappingFields, MAX_CACHE_TTL_SECONDS } from './mappingEngine/mappingFields';
export type { MappingFields } from './mappingEngine/mappingFields';
export { ResponseCache, cacheIdentity } from './gateway/ResponseCache';
export type { ResponseCacheOptions, CacheKeyParts } from './gateway/ResponseCache';
export { parseManagedCredentials } from './auth/oauthClient';
export type { ManagedCredentials, OAuthGrant } from './auth/oauthClient';
export { ManagedTokenService, connectionIdFromAuthorizationError } from './auth/managedTokenService';
export type { AccessTokenProvider, CredentialStatus, AuthorizationCallbackError } from './auth/managedTokenService';
export { buildAuthContext } from './auth/authContext';

export { createLogger, silentLogger } from './logging/logger';
export type { Logger, LogLevel, LogFields, LoggerOptions } from './logging/logger';

export {
  parseRateLimitSetting, serializeRateLimitSetting, deserializeRateLimitSetting, effectiveRateLimit, formatRateLimitSetting, MAX_RATE_LIMIT,
} from './rateLimit/rateLimitConfig';
export type { RateLimit, RateLimitSetting } from './rateLimit/rateLimitConfig';
export { TokenBucket } from './rateLimit/TokenBucket';
export type { TakeResult } from './rateLimit/TokenBucket';

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
