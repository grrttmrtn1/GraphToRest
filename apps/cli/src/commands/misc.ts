import type { Command } from 'commander';
import { action, type CliContext } from '../runtime';
import { usageError } from '../errors';
import { table } from '../output';

function positiveInt(flag: string) {
  return (value: string): number => {
    if (!/^\d+$/.test(value)) throw usageError(`${flag} must be a positive integer`);
    return Number(value);
  };
}

export function registerMiscCommands(program: Command, ctx: CliContext): void {
  program
    .command('adapters')
    .description('list the adapter types connections can use')
    .action(
      action(ctx, async (rt) => {
        const adapters = await rt.client().listAdapters();
        rt.out.result(adapters, (list) => list.join('\n'));
      })
    );

  program
    .command('activity')
    .description('show recent /api/* requests, newest first')
    .option('--limit <n>', 'rows per page (1-200, default 50)', positiveInt('--limit'))
    .option('--before <id>', 'show rows older than this row id', positiveInt('--before'))
    .action(
      action(ctx, async (rt, opts: { limit?: number; before?: number }) => {
        const page = await rt.client().listActivity({ limit: opts.limit, before: opts.before });
        rt.out.result(page, (p) => {
          if (p.items.length === 0) return 'No activity.';
          const rows = p.items.map((r) => [r.ts, String(r.status), r.method, r.path, `${r.durationMs}ms`]);
          const lines = [table(['TIME', 'STATUS', 'METHOD', 'PATH', 'LATENCY'], rows)];
          if (p.nextBefore !== null) lines.push(`More: gtr activity${opts.limit ? ` --limit ${opts.limit}` : ''} --before ${p.nextBefore}`);
          return lines.join('\n');
        });
      })
    );
}
