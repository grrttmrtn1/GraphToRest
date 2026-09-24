import type { Command } from 'commander';
import { action, requireMode, resolveSecret, type CliContext, type Runtime } from '../runtime';

function password(rt: Runtime, value: string | undefined, username: string): Promise<string> {
  return resolveSecret(rt, {
    value,
    envVar: 'GTR_ADMIN_PASSWORD',
    prompt: `Password for ${username}: `,
    missing: 'Provide a password with --password, GTR_ADMIN_PASSWORD, or run in a terminal to be prompted (12+ characters)',
  });
}

export function registerAdminCommands(program: Command, ctx: CliContext): void {
  const admin = program.command('admin').description('manage admin users (web UI and remote CLI logins)');

  admin
    .command('create')
    .description('create an admin user (in embedded mode this is the first-run bootstrap)')
    .requiredOption('--username <name>')
    .option('--password <password>', 'visible in shell history; prefer GTR_ADMIN_PASSWORD or the prompt')
    .action(
      action(ctx, async (rt, opts: { username: string; password?: string }) => {
        const user = await rt.client().createAdminUser({ username: opts.username, password: await password(rt, opts.password, opts.username) });
        rt.out.result(user, (u) => `Created admin user ${u.username}.`);
      })
    );

  admin
    .command('set-password')
    .description('reset an admin password and revoke their sessions (embedded mode only)')
    .requiredOption('--username <name>')
    .option('--password <password>', 'visible in shell history; prefer GTR_ADMIN_PASSWORD or the prompt')
    .action(
      action(ctx, async (rt, opts: { username: string; password?: string }) => {
        requireMode(
          rt,
          'embedded',
          '"admin set-password" is embedded-only (lockout recovery): run it where the SQLite file is, without --server/GTR_SERVER and after "gtr logout"'
        );
        await rt.client().setAdminPassword({ username: opts.username, password: await password(rt, opts.password, opts.username) });
        rt.out.result({ username: opts.username, passwordUpdated: true }, (r) => `Password updated for ${r.username}.`);
      })
    );
}
