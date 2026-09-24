import { GatewayError } from '@graphtorest/core';

export const EXIT_CODES = { general: 1, usage: 2, auth: 3, notFound: 4, conflict: 5 } as const;

const EXIT_BY_CODE: Record<string, number> = {
  USAGE: EXIT_CODES.usage,
  INVALID_INPUT: EXIT_CODES.usage,
  INVALID_REQUEST: EXIT_CODES.usage,
  MODE_UNSUPPORTED: EXIT_CODES.usage,
  UNAUTHORIZED: EXIT_CODES.auth,
  NOT_LOGGED_IN: EXIT_CODES.auth,
  NOT_FOUND: EXIT_CODES.notFound,
  CONFLICT: EXIT_CODES.conflict,
};

export function exitCodeFor(code: string): number {
  return EXIT_BY_CODE[code] ?? EXIT_CODES.general;
}

/** Every failure the CLI reports ends up as one of these: a stable code, a user-facing message, an exit code. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode: number = exitCodeFor(code)) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function usageError(message: string): CliError {
  return new CliError('USAGE', message);
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof GatewayError) return new CliError(err.code, err.message);
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') return new CliError('CONFLICT', `Already exists: ${message}`);
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return new CliError('INVALID_INPUT', `References a record that does not exist: ${message}`);
  return new CliError('ERROR', message);
}
