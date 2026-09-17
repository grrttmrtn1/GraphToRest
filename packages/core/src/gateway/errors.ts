export class GatewayError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ErrorResponse {
  status: number;
  body: { error: { code: string; message: string; details: Record<string, unknown> } };
}

export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof GatewayError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} } } };
}
