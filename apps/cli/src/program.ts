import { Command, CommanderError } from 'commander';
import { EXIT_CODES, toCliError } from './errors';
import type { CliContext } from './runtime';
import { registerAuthCommands } from './commands/auth';
import { registerConnectionCommands } from './commands/connection';
import { registerMappingCommands } from './commands/mapping';
import { registerApiKeyCommands } from './commands/apikey';
import { registerAdminCommands } from './commands/admin';
import { registerMiscCommands } from './commands/misc';

export function buildProgram(ctx: CliContext): Command {
  const program = new Command();
  program
    .name('gtr')
    .description('GraphToRest CLI: embedded (SQLite file) or remote (running server) mode')
    .option('--server <url>', 'remote mode against this server (or set GTR_SERVER / run "gtr login")')
    .option('--db <path>', 'SQLite file for embedded mode (default: $DB_PATH or ./data/graphtorest.db)')
    .option('--json', 'print raw JSON instead of tables')
    // Both settings are inherited by every subcommand created after this point.
    .exitOverride()
    .configureOutput({ writeOut: (text) => ctx.io.out(text), writeErr: (text) => ctx.io.err(text) });

  registerAuthCommands(program, ctx);
  registerConnectionCommands(program, ctx);
  registerMappingCommands(program, ctx);
  registerApiKeyCommands(program, ctx);
  registerAdminCommands(program, ctx);
  registerMiscCommands(program, ctx);
  return program;
}

/** Runs one CLI invocation and returns the process exit code. Never calls process.exit. */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const program = buildProgram(ctx);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    // Commander already printed its own message (usage errors) or the help text.
    if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : EXIT_CODES.usage;
    const cliError = toCliError(err);
    ctx.io.err(`error: ${cliError.message}\n`);
    if (ctx.env.GTR_DEBUG === '1' && err instanceof Error && err.stack) ctx.io.err(`${err.stack}\n`);
    return cliError.exitCode;
  }
}
