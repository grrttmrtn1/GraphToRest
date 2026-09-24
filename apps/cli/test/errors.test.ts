import { describe, it, expect } from 'vitest';
import { GatewayError } from '@graphtorest/core';
import { CliError, EXIT_CODES, exitCodeFor, toCliError, usageError } from '../src/errors';

describe('exitCodeFor', () => {
  it('maps error codes to the documented exit codes', () => {
    expect(exitCodeFor('USAGE')).toBe(EXIT_CODES.usage);
    expect(exitCodeFor('INVALID_INPUT')).toBe(2);
    expect(exitCodeFor('INVALID_REQUEST')).toBe(2);
    expect(exitCodeFor('MODE_UNSUPPORTED')).toBe(2);
    expect(exitCodeFor('UNAUTHORIZED')).toBe(3);
    expect(exitCodeFor('NOT_LOGGED_IN')).toBe(3);
    expect(exitCodeFor('NOT_FOUND')).toBe(4);
    expect(exitCodeFor('CONFLICT')).toBe(5);
    expect(exitCodeFor('INTERNAL_ERROR')).toBe(1);
    expect(exitCodeFor('SOMETHING_NEW')).toBe(1);
  });
});

describe('toCliError', () => {
  it('passes a CliError through unchanged', () => {
    const err = usageError('bad flag');
    expect(toCliError(err)).toBe(err);
    expect(err).toMatchObject({ code: 'USAGE', exitCode: 2, message: 'bad flag' });
  });

  it('keeps a GatewayError code and message', () => {
    const converted = toCliError(new GatewayError('NOT_FOUND', 'Connection not found', 404));
    expect(converted).toBeInstanceOf(CliError);
    expect(converted).toMatchObject({ code: 'NOT_FOUND', message: 'Connection not found', exitCode: 4 });
  });

  it('maps SQLite constraint failures', () => {
    const unique = Object.assign(new Error('UNIQUE constraint failed: connections.name'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    const foreignKey = Object.assign(new Error('FOREIGN KEY constraint failed'), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
    expect(toCliError(unique)).toMatchObject({ code: 'CONFLICT', exitCode: 5 });
    expect(toCliError(foreignKey)).toMatchObject({ code: 'INVALID_INPUT', exitCode: 2 });
  });

  it('wraps anything else as a general error', () => {
    expect(toCliError(new Error('boom'))).toMatchObject({ code: 'ERROR', message: 'boom', exitCode: 1 });
    expect(toCliError('text')).toMatchObject({ code: 'ERROR', message: 'text', exitCode: 1 });
  });
});
