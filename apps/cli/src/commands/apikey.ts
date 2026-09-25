import type { Command } from 'commander';
import { formatRateLimitSetting, type RateLimitSetting } from '@graphtorest/core';
import { action, confirmOrRefuse, type CliContext } from '../runtime';
import { table } from '../output';
import { usageError } from '../errors';

interface RateLimitFlags {
  rateLimit?: string;
  burst?: string;
  unlimited?: boolean;
  default?: boolean;
}

function positiveIntFlag(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw usageError(`${flag} must be a positive integer`);
  return n;
}

/** Maps the flags to a setting; undefined means "no rate-limit flag given". */
export function rateLimitFromFlags(opts: RateLimitFlags): RateLimitSetting | undefined {
  const chosen = [opts.rateLimit !== undefined, opts.unlimited === true, opts.default === true].filter(Boolean).length;
  if (chosen > 1) throw usageError('Use only one of --rate-limit, --unlimited, --default');
  if (opts.burst !== undefined && opts.rateLimit === undefined) throw usageError('--burst requires --rate-limit');
  if (opts.unlimited) return 'unlimited';
  if (opts.default) return null;
  if (opts.rateLimit === undefined) return undefined;
  const requestsPerMinute = positiveIntFlag(opts.rateLimit, '--rate-limit');
  return { requestsPerMinute, burst: opts.burst === undefined ? requestsPerMinute : positiveIntFlag(opts.burst, '--burst') };
}

export function registerApiKeyCommands(program: Command, ctx: CliContext): void {
  const apikey = program.command('apikey').description('manage developer API keys for /api/*');

  apikey
    .command('create')
    .description('create an API key (the plaintext is shown only once)')
    .option('--label <label>')
    .option('--rate-limit <perMinute>', 'requests per minute for this key (default: server default)')
    .option('--burst <n>', 'bucket size (default: the rate)')
    .option('--unlimited', 'exempt this key from rate limiting')
    .action(
      action(ctx, async (rt, opts: { label?: string } & RateLimitFlags) => {
        const rateLimit = rateLimitFromFlags(opts);
        const created = await rt.client().createApiKey({ label: opts.label, ...(rateLimit !== undefined ? { rateLimit } : {}) });
        rt.out.result(created, (k) => {
          const header = `Created API key ${k.id}${k.label ? ` (${k.label})` : ''}:\n${k.plaintext}`;
          return k.rateLimit !== null ? `${header}\nRate limit: ${formatRateLimitSetting(k.rateLimit)}` : header;
        });
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
            : table(
                ['ID', 'LABEL', 'RATE LIMIT', 'CREATED', 'LAST USED'],
                list.map((k) => [k.id, k.label ?? '-', formatRateLimitSetting(k.rateLimit), k.createdAt, k.lastUsedAt ?? 'never'])
              )
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

  apikey
    .command('update <id>')
    .description("change an API key's rate limit")
    .option('--rate-limit <perMinute>', 'requests per minute')
    .option('--burst <n>', 'bucket size (default: the rate)')
    .option('--unlimited', 'exempt this key from rate limiting')
    .option('--default', 'use the server default (RATE_LIMIT_DEFAULT)')
    .action(
      action(ctx, async (rt, id: string, opts: RateLimitFlags) => {
        const rateLimit = rateLimitFromFlags(opts);
        if (rateLimit === undefined) throw usageError('Nothing to update: pass --rate-limit, --unlimited or --default');
        const updated = await rt.client().updateApiKeyRateLimit(id, rateLimit);
        rt.out.result(updated, (k) => `API key ${k.id} rate limit: ${formatRateLimitSetting(k.rateLimit)}.`);
      })
    );
}
