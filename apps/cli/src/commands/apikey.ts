import type { Command } from 'commander';
import { action, confirmOrRefuse, type CliContext } from '../runtime';
import { table } from '../output';

export function registerApiKeyCommands(program: Command, ctx: CliContext): void {
  const apikey = program.command('apikey').description('manage developer API keys for /api/*');

  apikey
    .command('create')
    .description('create an API key (the plaintext is shown only once)')
    .option('--label <label>')
    .action(
      action(ctx, async (rt, opts: { label?: string }) => {
        const created = await rt.client().createApiKey({ label: opts.label });
        rt.out.result(created, (k) => `Created API key ${k.id}${k.label ? ` (${k.label})` : ''}:\n${k.plaintext}`);
        rt.out.warn('Store this key now; it cannot be shown again.');
      })
    );

  apikey
    .command('list')
    .description('list API keys (never the secrets)')
    .action(
      action(ctx, async (rt) => {
        const keys = await rt.client().listApiKeys();
        rt.out.result(keys, (list) =>
          list.length === 0
            ? 'No API keys.'
            : table(['ID', 'LABEL', 'CREATED', 'LAST USED'], list.map((k) => [k.id, k.label ?? '-', k.createdAt, k.lastUsedAt ?? 'never']))
        );
      })
    );

  apikey
    .command('revoke <id>')
    .description('revoke an API key')
    .option('--yes', 'do not ask for confirmation')
    .action(
      action(ctx, async (rt, id: string, opts: { yes?: boolean }) => {
        if (!(await confirmOrRefuse(rt, opts.yes, `Revoke API key ${id}?`))) return;
        await rt.client().revokeApiKey(id);
        rt.out.done(`Revoked API key ${id}.`);
      })
    );
}
