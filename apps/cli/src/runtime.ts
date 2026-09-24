import type { Command } from 'commander';
import { CliError, usageError } from './errors';
import { Output, type Io } from './output';
import { resolveMode, type GlobalOptions, type Mode } from './mode';
import { profilePath, readProfile } from './profile';
import type { Prompter } from './prompt';
import type { GtrClient } from './client/types';
import { EmbeddedClient } from './client/embedded';
import { RemoteClient } from './client/remote';

export interface CliContext {
  env: NodeJS.ProcessEnv;
  io: Io;
  prompter: Prompter;
  fetchImpl?: typeof fetch;
  /** Test seam; defaults to EmbeddedClient / RemoteClient. */
  openClient?: (mode: Mode) => GtrClient;
}

export interface Runtime {
  ctx: CliContext;
  globals: GlobalOptions;
  out: Output;
  profileFile: string;
  /** Resolved lazily so login/logout never trip over mode resolution. */
  mode(): Mode;
  /** Opened lazily on first use and closed after the action. */
  client(): GtrClient;
}

function defaultOpenClient(ctx: CliContext, mode: Mode): GtrClient {
  return mode.kind === 'embedded'
    ? EmbeddedClient.open(mode.dbPath, ctx.env)
    : new RemoteClient({ server: mode.server, token: mode.token, source: mode.source, fetchImpl: ctx.fetchImpl });
}

/** Wraps a commander action: commander passes (...positionals, options, command). */
export function action<A extends unknown[]>(ctx: CliContext, fn: (rt: Runtime, ...args: A) => Promise<void>) {
  return async (...args: unknown[]): Promise<void> => {
    const command = args[args.length - 1] as Command;
    const globals = command.optsWithGlobals() as GlobalOptions;
    const profileFile = profilePath(ctx.env);
    let mode: Mode | undefined;
    let client: GtrClient | undefined;
    const rt: Runtime = {
      ctx,
      globals,
      profileFile,
      out: new Output(ctx.io, globals.json === true),
      mode: () => (mode ??= resolveMode(globals, ctx.env, () => readProfile(profileFile))),
      client: () => (client ??= (ctx.openClient ?? ((m: Mode) => defaultOpenClient(ctx, m)))(rt.mode())),
    };
    try {
      await fn(rt, ...(args.slice(0, -1) as A));
    } finally {
      client?.close();
    }
  };
}

export function requireMode(rt: Runtime, kind: Mode['kind'], message: string): void {
  if (rt.mode().kind !== kind) throw new CliError('MODE_UNSUPPORTED', message);
}

/** Flag, then env var, then a hidden prompt on a terminal; otherwise a usage error (never hangs in CI). */
export async function resolveSecret(
  rt: Runtime,
  opts: { value?: string; envVar: string; prompt: string; missing: string }
): Promise<string> {
  const provided = opts.value ?? rt.ctx.env[opts.envVar];
  if (provided) return provided;
  if (rt.ctx.prompter.isInteractive()) {
    const answer = await rt.ctx.prompter.askHidden(opts.prompt);
    if (answer) return answer;
  }
  throw usageError(opts.missing);
}

export async function resolveText(rt: Runtime, value: string | undefined, prompt: string, missing: string): Promise<string> {
  if (value) return value;
  if (rt.ctx.prompter.isInteractive()) {
    const answer = await rt.ctx.prompter.ask(prompt);
    if (answer) return answer;
  }
  throw usageError(missing);
}

/** true = go ahead. Without a terminal, --yes is mandatory. */
export async function confirmOrRefuse(rt: Runtime, yes: boolean | undefined, question: string): Promise<boolean> {
  if (yes) return true;
  if (!rt.ctx.prompter.isInteractive()) {
    throw usageError('Refusing to delete without confirmation: pass --yes when not running in a terminal');
  }
  const confirmed = await rt.ctx.prompter.confirm(question);
  if (!confirmed) rt.out.warn('Cancelled.');
  return confirmed;
}

export function parseJsonObject(text: string, flag: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageError(`${flag} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw usageError(`${flag} must be a JSON object`);
  return parsed as Record<string, unknown>;
}
