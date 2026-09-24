import fs from 'node:fs';
import type { Command } from 'commander';
import { action, resolveSecret, resolveText, type CliContext, type Runtime } from '../runtime';
import { usageError } from '../errors';
import { normalizeServerUrl, type ModeSource } from '../mode';
import { readProfile, writeProfile, deleteProfile, type Profile } from '../profile';
import { RemoteClient } from '../client/remote';
import type { ClientStatus } from '../client/types';

type StatusView =
  | { mode: 'embedded'; dbPath: string; exists: boolean; adminUsers?: number }
  | Extract<ClientStatus, { mode: 'remote' }>;

function loginTarget(rt: Runtime): { server: string; source: ModeSource } {
  if (rt.globals.server !== undefined) return { server: normalizeServerUrl(rt.globals.server), source: '--server' };
  if (rt.ctx.env.GTR_SERVER) return { server: normalizeServerUrl(rt.ctx.env.GTR_SERVER), source: 'GTR_SERVER' };
  const profile = readProfile(rt.profileFile);
  if (profile) return { server: normalizeServerUrl(profile.server), source: 'profile' };
  throw usageError('No server to log in to: run "gtr login --server <url>"');
}

function renderStatus(view: StatusView): string {
  if (view.mode === 'embedded') {
    const lines = ['mode: embedded', `database: ${view.dbPath} (${view.exists ? 'exists' : 'not created yet'})`];
    if (view.adminUsers !== undefined) lines.push(`admin users: ${view.adminUsers}`);
    return lines.join('\n');
  }
  const session =
    view.session === 'not-logged-in'
      ? `not logged in (run "gtr login --server ${view.server}")`
      : view.session === 'expired'
        ? `expired or revoked (run "gtr login --server ${view.server}")`
        : `logged in as ${view.session.username} until ${view.session.expiresAt}`;
  return ['mode: remote', `server: ${view.server} (via ${view.source})`, `session: ${session}`].join('\n');
}

export function registerAuthCommands(program: Command, ctx: CliContext): void {
  program
    .command('login')
    .description('log in to a GraphToRest server and save the session for later commands')
    .option('--username <name>', 'admin username (prompted on a terminal when omitted)')
    .action(
      action(ctx, async (rt, opts: { username?: string }) => {
        const { server, source } = loginTarget(rt);
        const username = await resolveText(rt, opts.username, 'Username: ', 'Provide --username');
        const password = await resolveSecret(rt, {
          envVar: 'GTR_ADMIN_PASSWORD',
          prompt: 'Password: ',
          missing: 'Provide the password with the GTR_ADMIN_PASSWORD environment variable, or run in a terminal to be prompted',
        });
        const session = await RemoteClient.login({ server, source, fetchImpl: ctx.fetchImpl }, username, password);
        writeProfile(rt.profileFile, { server, username, token: session.token, expiresAt: session.expiresAt });
        rt.out.result(
          { server, username, expiresAt: session.expiresAt },
          (r) => `Logged in to ${r.server} as ${r.username} (session expires ${r.expiresAt}).`
        );
      })
    );

  program
    .command('logout')
    .description('end the saved session and delete the local profile')
    .action(
      action(ctx, async (rt) => {
        let profile: Profile | null = null;
        try {
          profile = readProfile(rt.profileFile);
        } catch {
          // A malformed profile is still deleted below.
        }
        if (profile) {
          try {
            await new RemoteClient({ server: profile.server, token: profile.token, source: 'profile', fetchImpl: ctx.fetchImpl }).logout();
          } catch {
            // Best effort: an expired session or an unreachable server must not keep the local token around.
          }
        }
        const removed = deleteProfile(rt.profileFile);
        rt.out.done(removed ? (profile ? `Logged out of ${profile.server}.` : 'Removed the local CLI profile.') : 'Not logged in.');
      })
    );

  program
    .command('status')
    .description('show which mode gtr uses, and the database or session it would use')
    .action(
      action(ctx, async (rt) => {
        const mode = rt.mode();
        if (mode.kind === 'embedded' && !fs.existsSync(mode.dbPath)) {
          rt.out.result<StatusView>({ mode: 'embedded', dbPath: mode.dbPath, exists: false }, renderStatus);
          return;
        }
        const status = await rt.client().describe();
        const view: StatusView = status.mode === 'embedded' ? { ...status, exists: true } : status;
        rt.out.result(view, renderStatus);
      })
    );
}
