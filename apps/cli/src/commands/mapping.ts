import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { parseRouteString } from '@graphtorest/core';
import { action, confirmOrRefuse, parseJsonObject, type CliContext } from '../runtime';
import { CliError, usageError } from '../errors';
import { table } from '../output';
import { resolveConnection } from '../client/resolve';
import type { MappingPatch } from '../client/types';

function parseRoute(text: string): { method: string; route: string } {
  try {
    return parseRouteString(text);
  } catch (err) {
    throw usageError((err as Error).message);
  }
}

/** A JSON object of strings, or the literal null (clears the template). */
function parseTemplate(text: string): Record<string, string> | null {
  if (text.trim() === 'null') return null;
  return parseJsonObject(text, '--response-template') as Record<string, string>;
}

/** 0 clears the TTL (stored as null); anything else must be a whole number of seconds up to a day. */
function parseCacheTtl(text: string): number | null {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 86_400) throw usageError('--cache-ttl must be a whole number of seconds from 0 to 86400');
  return n === 0 ? null : n;
}

export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

function readTextFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError('FILE_ERROR', `Cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? 'unreadable'}`);
  }
}

export function registerMappingCommands(program: Command, ctx: CliContext): void {
  const mapping = program.command('mapping').description('manage REST route mappings');

  mapping
    .command('create')
    .description('create a manual mapping')
    .requiredOption('--connection <conn>', 'connection id or name')
    .requiredOption('--route <route>', 'e.g. "GET /users/{id}"')
    .requiredOption('--operation <json>', 'JSON operation object')
    .option('--response-template <json>', 'JSON map of output field to JSONPath')
    .option('--cache-ttl <seconds>', 'cache successful GET responses for this long (0 = off)')
    .action(
      action(
        ctx,
        async (rt, opts: { connection: string; route: string; operation: string; responseTemplate?: string; cacheTtl?: string }) => {
          const { method, route } = parseRoute(opts.route);
          const operation = parseJsonObject(opts.operation, '--operation');
          const responseTemplate = opts.responseTemplate === undefined ? undefined : parseTemplate(opts.responseTemplate);
          const cacheTtlSeconds = opts.cacheTtl === undefined ? undefined : parseCacheTtl(opts.cacheTtl);
          const client = rt.client();
          const connection = await resolveConnection(client, opts.connection);
          const created = await client.createMapping({ connectionId: connection.id, method, route, operation, responseTemplate, cacheTtlSeconds });
          rt.out.result(created, (m) => `Created mapping ${m.method} ${m.route} (${m.id}).`);
        }
      )
    );

  mapping
    .command('list')
    .description('list mappings')
    .option('--connection <conn>', 'only this connection (id or name)')
    .action(
      action(ctx, async (rt, opts: { connection?: string }) => {
        const client = rt.client();
        const connections = await client.listConnections();
        const only = opts.connection === undefined ? undefined : await resolveConnection(client, opts.connection);
        const mappings = (await client.listMappings()).filter((m) => !only || m.connectionId === only.id);
        const names = new Map(connections.map((c) => [c.id, c.name]));
        rt.out.result(mappings, (list) =>
          list.length === 0
            ? 'No mappings.'
            : table(
                ['ID', 'METHOD', 'ROUTE', 'CONNECTION', 'SOURCE', 'CACHE'],
                list.map((m) => [
                  m.id,
                  m.method,
                  m.route,
                  names.get(m.connectionId) ?? m.connectionId,
                  m.source,
                  m.cacheTtlSeconds ? `${m.cacheTtlSeconds}s` : '-',
                ])
              )
        );
      })
    );

  mapping
    .command('update <id>')
    .description('edit a mapping (route/operation/template edits make it source=manual)')
    .option('--route <route>', 'e.g. "GET /users/{id}"')
    .option('--operation <json>', 'JSON operation object')
    .option('--response-template <json>', 'JSON map of output field to JSONPath, or null to clear')
    .option('--cache-ttl <seconds>', 'cache successful GET responses for this long (0 = off)')
    .action(
      action(ctx, async (rt, id: string, opts: { route?: string; operation?: string; responseTemplate?: string; cacheTtl?: string }) => {
        const patch: MappingPatch = {};
        if (opts.route !== undefined) Object.assign(patch, parseRoute(opts.route));
        if (opts.operation !== undefined) patch.operation = parseJsonObject(opts.operation, '--operation');
        if (opts.responseTemplate !== undefined) patch.responseTemplate = parseTemplate(opts.responseTemplate);
        if (opts.cacheTtl !== undefined) patch.cacheTtlSeconds = parseCacheTtl(opts.cacheTtl);
        const updated = await rt.client().updateMapping(id, patch);
        rt.out.result(updated, (m) => `Updated mapping ${m.method} ${m.route} (${m.id}); source is ${m.source}.`);
      })
    );

  mapping
    .command('delete <id>')
    .description('delete a mapping')
    .option('--yes', 'do not ask for confirmation')
    .action(
      action(ctx, async (rt, id: string, opts: { yes?: boolean }) => {
        if (!(await confirmOrRefuse(rt, opts.yes, `Delete mapping ${id}?`))) return;
        await rt.client().deleteMapping(id);
        rt.out.done(`Deleted mapping ${id}.`);
      })
    );

  mapping
    .command('generate')
    .description("generate mappings from the connection's schema")
    .requiredOption('--connection <conn>', 'connection id or name')
    .option('--force', 'also overwrite manual mappings')
    .option('--vendor-token <token>', 'vendor access token for passthrough connections')
    .action(
      action(ctx, async (rt, opts: { connection: string; force?: boolean; vendorToken?: string }) => {
        const client = rt.client();
        const connection = await resolveConnection(client, opts.connection);
        const result = await client.generateMappings(connection.id, { force: opts.force === true, vendorToken: opts.vendorToken });
        rt.out.result(result, (r) =>
          [
            `Generated mappings for ${connection.name}: ${r.created.length} created, ${r.updated.length} updated, ${r.skipped.length} skipped, ${r.conflicts.length} conflicts.`,
            ...r.conflicts.map((d) => `  conflict: ${d.method} ${d.route}`),
            ...(r.skipped.length > 0 && !opts.force ? ['  (skipped mappings are manual; use --force to overwrite them)'] : []),
          ].join('\n')
        );
      })
    );

  mapping
    .command('export')
    .description('export mappings as YAML (stdout, or --out FILE)')
    .option('--connection <conn>', 'only this connection (id or name)')
    .option('--out <file>', 'write to this file instead of stdout')
    .action(
      action(ctx, async (rt, opts: { connection?: string; out?: string }) => {
        const client = rt.client();
        const connectionId = opts.connection === undefined ? undefined : (await resolveConnection(client, opts.connection)).id;
        const yaml = await client.exportMappings({ connectionId });
        if (opts.out === undefined) {
          rt.out.raw(yaml);
          return;
        }
        writeFileAtomic(opts.out, yaml);
        rt.out.result({ file: opts.out }, (r) => `Wrote mappings to ${r.file}.`);
      })
    );

  mapping
    .command('import <file>')
    .description('import mappings from a YAML file (all-or-nothing)')
    .action(
      action(ctx, async (rt, file: string) => {
        const result = await rt.client().importMappings(readTextFile(file));
        if (!rt.out.json) for (const warning of result.warnings) rt.out.warn(`warning: ${warning}`);
        rt.out.result(result, (r) => `Imported ${r.imported} mapping(s).`);
      })
    );
}
