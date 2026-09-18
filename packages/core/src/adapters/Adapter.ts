export interface AuthContext {
  connectionId: string;
  vendorToken?: string;
  authMode?: string;
  config?: Record<string, unknown> | null;
}

export interface RequestContext {
  query?: Record<string, string>;
  body?: unknown;
}

export interface MappingDraft {
  route: string;
  method: string;
  operation: Record<string, unknown>;
  responseTemplate?: Record<string, string> | null;
}

export interface Adapter {
  readonly type: string;
  introspect(authContext: AuthContext): Promise<unknown>;
  generateMappings(introspection: unknown): Promise<MappingDraft[]>;
  execute(
    operation: Record<string, unknown>,
    params: Record<string, string>,
    authContext: AuthContext,
    request?: RequestContext
  ): Promise<unknown>;
}
