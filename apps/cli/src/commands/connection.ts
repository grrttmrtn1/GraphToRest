import fs from 'node:fs';
import type { Command } from 'commander';
import { action, requireMode, confirmOrRefuse, parseJsonObject, type CliContext } from '../runtime';
import { CliError, toCliError, usageError } from '../errors';
import { table } from '../output';
import { resolveConnection } from '../client/resolve';
import type { ConnectionRecord, CredentialStatus } from '../client/types';

type CredentialView = CredentialStatus | { unavailable: string };

export function describeCredentials(status: CredentialView): string {
  if ('unavailable' in status) return `unavailable (${status.unavailable})`;
  if (!status.configured) return 'not configured';
  return `configured (grant: ${status.grant}, refresh token: ${status.hasRefreshToken ? 'yes' : 'no'})`;
}

function readCredentials(opts: { credentials?: string; credentialsFile?: string }): unknown {
  if (Boolean(opts.credentials) === Boolean(opts.credentialsFile)) {
    throw usageError('Provide exactly one of --credentials or --credentials-file');
  }
  let raw: string;
  try {
    raw = opts.credentials ?? fs.readFileSync(opts.credentialsFile!, 'utf8');
  } catch (err) {
    throw new CliError('FILE_ERROR', `Cannot read ${opts.credentialsFile}: ${(err as NodeJS.ErrnoException).code ?? 'unreadable'}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Deliberately generic: a JSON.parse message can quote a fragment of the secret-bearing input.
    throw usageError('Credentials are not valid JSON');
  }
}

export function registerConnectionCommands(program: Command, ctx: CliContext): void {
  const connection = program.command('connection').description('manage vendor connections');

  connection
    .command('create')
    .description('create a connection')
    .requiredOption('--name <name>')
    .requiredOption('--adapter-type <type>', 'see "gtr adapters"')
    .requiredOption('--auth-mode <mode>', 'passthrough or managed')
    .option('--config <json>', 'JSON adapter config, e.g. {"endpoint":"https://api.example.com/graphql"}')
    .action(
      action(ctx, async (rt, opts: { name: string; adapterType: string; authMode: string; config?: string }) => {
        const created = await rt.client().createConnection({
          name: opts.name,
          adapterType: opts.adapterType,
          authMode: opts.authMode,
          config: opts.config === undefined ? undefined : parseJsonObject(opts.config, '--config'),
        });
        rt.out.result(created, (c) => `Created connection ${c.name} (${c.id}).`);
      })
    );

  connection
    .command('list')
    .description('list connections')
    .action(
      action(ctx, async (rt) => {
        const connections = await rt.client().listConnections();
        rt.out.result(connections, (list) =>
          list.length === 0
            ? 'No connections.'
            : table(['ID', 'NAME', 'ADAPTER', 'AUTH MODE'], list.map((c) => [c.id, c.name, c.adapterType, c.authMode]))
        );
      })
    );

  connection
    .command('show <conn>')
    .description('show one connection (id or name), including credential status for managed connections')
    .action(
      action(ctx, async (rt, ref: string) => {
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        let credentials: CredentialView | undefined;
        if (found.authMode === 'managed') {
          try {
            credentials = await client.getCredentialStatus(found.id);
          } catch (err) {
            const cliError = toCliError(err);
            if (cliError.code !== 'MANAGED_AUTH_DISABLED') throw cliError;
            credentials = { unavailable: cliError.message };
          }
        }
        rt.out.result({ ...found, ...(credentials ? { credentials } : {}) }, (c: ConnectionRecord & { credentials?: CredentialView }) =>
          [
            `id: ${c.id}`,
            `name: ${c.name}`,
            `adapter: ${c.adapterType}`,
            `auth mode: ${c.authMode}`,
            `config: ${c.config ? JSON.stringify(c.config) : '-'}`,
            ...(c.credentials ? [`credentials: ${describeCredentials(c.credentials)}`] : []),
          ].join('\n')
        );
      })
    );

  connection
    .command('delete <conn>')
    .description('delete a connection and all of its mappings')
    .option('--yes', 'do not ask for confirmation')
    .action(
      action(ctx, async (rt, ref: string, opts: { yes?: boolean }) => {
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        if (!(await confirmOrRefuse(rt, opts.yes, `Delete connection "${found.name}" (${found.id}) and all of its mappings?`))) return;
        await client.deleteConnection(found.id);
        rt.out.done(`Deleted connection ${found.name} (${found.id}).`);
      })
    );

  const credentials = connection.command('credentials').description('manage stored credentials of a managed connection');

  credentials
    .command('set <conn>')
    .description('store vendor app credentials (encrypted at rest)')
    .option('--credentials-file <path>', 'JSON file holding the credentials object (recommended)')
    .option('--credentials <json>', 'credentials JSON (visible in shell history; prefer --credentials-file)')
    .action(
      action(ctx, async (rt, ref: string, opts: { credentials?: string; credentialsFile?: string }) => {
        const payload = readCredentials(opts);
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        const status = await client.setCredentials(found.id, payload);
        rt.out.result(status, (s) => `Stored credentials for ${found.name}: ${describeCredentials(s)}.`);
      })
    );

  credentials
    .command('status <conn>')
    .description('show whether credentials are stored (never the secrets)')
    .action(
      action(ctx, async (rt, ref: string) => {
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        const status = await client.getCredentialStatus(found.id);
        rt.out.result(status, (s) => `${found.name}: ${describeCredentials(s)}`);
      })
    );

  credentials
    .command('clear <conn>')
    .description('delete stored credentials and cached tokens')
    .option('--yes', 'do not ask for confirmation')
    .action(
      action(ctx, async (rt, ref: string, opts: { yes?: boolean }) => {
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        if (!(await confirmOrRefuse(rt, opts.yes, `Clear stored credentials for "${found.name}"?`))) return;
        await client.clearCredentials(found.id);
        rt.out.done(`Cleared credentials for ${found.name}.`);
      })
    );

  connection
    .command('authorize <conn>')
    .description('start the OAuth authorization-code flow (remote mode only)')
    .action(
      action(ctx, async (rt, ref: string) => {
        requireMode(
          rt,
          'remote',
          '"connection authorize" needs remote mode: the vendor redirects to a running server\'s /admin/oauth/callback. Run "gtr login --server <url>" first.'
        );
        const client = rt.client();
        const found = await resolveConnection(client, ref);
        const { authorizationUrl } = await client.startAuthorization(found.id);
        rt.out.result({ authorizationUrl }, (r) => `Open this URL in a browser to authorize "${found.name}":\n${r.authorizationUrl}`);
      })
    );
}
