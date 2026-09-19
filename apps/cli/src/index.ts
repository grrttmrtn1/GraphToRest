#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import { openEmbeddedStore, openManagedAuth } from './embeddedClient';
import { connectionCreate } from './commands/connectionCreate';
import { mappingCreate } from './commands/mappingCreate';
import { apiKeyCreate } from './commands/apiKeyCreate';
import { mappingGenerate } from './commands/mappingGenerate';
import { mappingUpdate } from './commands/mappingUpdate';
import { mappingExport } from './commands/mappingExport';
import { mappingImport } from './commands/mappingImport';
import { adminCreate, adminSetPassword } from './commands/adminCreate';
import { connectionCredentialsSet } from './commands/connectionCredentialsSet';

const program = new Command();
program.name('gtr').option('--db <path>', 'SQLite file path', process.env.DB_PATH ?? './data/graphtorest.db');

program
  .command('connection-create')
  .requiredOption('--name <name>')
  .requiredOption('--adapter-type <type>')
  .requiredOption('--auth-mode <mode>')
  .option('--config <json>', 'JSON-encoded adapter config, e.g. a GraphQL endpoint URL')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const result = connectionCreate(store, {
      name: opts.name,
      adapterType: opts.adapterType,
      authMode: opts.authMode,
      config: opts.config ? JSON.parse(opts.config) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('mapping-create')
  .requiredOption('--connection-id <id>')
  .requiredOption('--route <route>', 'e.g. "GET /users/{id}"')
  .requiredOption('--operation <json>', 'JSON-encoded operation object')
  .option('--response-template <json>', 'JSON-encoded response template')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const result = mappingCreate(store, {
      connectionId: opts.connectionId,
      route: opts.route,
      operation: JSON.parse(opts.operation),
      responseTemplate: opts.responseTemplate ? JSON.parse(opts.responseTemplate) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('mapping-generate')
  .requiredOption('--connection-id <id>')
  .option('--vendor-token <token>')
  .option('--force', 'overwrite manual mappings too', false)
  .action(async (opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const result = await mappingGenerate(store, {
      connectionId: opts.connectionId,
      vendorToken: opts.vendorToken,
      force: opts.force,
      tokenProvider: openManagedAuth(store),
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('mapping-update')
  .requiredOption('--id <id>')
  .option('--route <route>', 'e.g. "GET /users/{id}"')
  .option('--operation <json>', 'JSON-encoded operation object')
  .option('--response-template <json>', 'JSON-encoded response template')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const result = mappingUpdate(store, {
      id: opts.id,
      route: opts.route,
      operation: opts.operation ? JSON.parse(opts.operation) : undefined,
      responseTemplate: opts.responseTemplate ? JSON.parse(opts.responseTemplate) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('mapping-export')
  .option('--out <file>', 'write YAML to this file instead of stdout')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const yamlText = mappingExport(store, { outFile: opts.out });
    if (!opts.out) console.log(yamlText);
  });

program
  .command('mapping-import <file>')
  .action((file) => {
    const store = openEmbeddedStore(program.opts().db);
    const result = mappingImport(store, { file });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('apikey-create')
  .option('--label <label>')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    console.log(JSON.stringify(apiKeyCreate(store, { label: opts.label }), null, 2));
  });

function resolvePassword(option: string | undefined): string {
  const password = option ?? process.env.GTR_ADMIN_PASSWORD;
  if (!password) throw new Error('Provide a password with --password or the GTR_ADMIN_PASSWORD environment variable');
  return password;
}

program
  .command('admin-create')
  .requiredOption('--username <name>')
  .option('--password <password>', 'defaults to $GTR_ADMIN_PASSWORD (12+ characters)')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    const user = adminCreate(store, { username: opts.username, password: resolvePassword(opts.password) });
    console.log(JSON.stringify(user, null, 2));
  });

program
  .command('admin-set-password')
  .requiredOption('--username <name>')
  .option('--password <password>', 'defaults to $GTR_ADMIN_PASSWORD (12+ characters)')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    adminSetPassword(store, { username: opts.username, password: resolvePassword(opts.password) });
    console.log(JSON.stringify({ username: opts.username, passwordUpdated: true }));
  });

program
  .command('connection-credentials')
  .requiredOption('--connection-id <id>')
  .option('--credentials <json>', 'JSON credentials object (visible in shell history; prefer --credentials-file)')
  .option('--credentials-file <path>', 'path to a JSON file holding the credentials object')
  .action((opts) => {
    if (Boolean(opts.credentials) === Boolean(opts.credentialsFile)) {
      throw new Error('Provide exactly one of --credentials or --credentials-file');
    }
    const store = openEmbeddedStore(program.opts().db);
    const raw = opts.credentials ?? fs.readFileSync(opts.credentialsFile, 'utf8');
    let credentials: unknown;
    try {
      credentials = JSON.parse(raw);
    } catch {
      // Deliberately generic: a JSON.parse message can quote a fragment of the secret-bearing input.
      throw new Error('Credentials are not valid JSON');
    }
    const status = connectionCredentialsSet(store, openManagedAuth(store), {
      connectionId: opts.connectionId,
      credentials,
    });
    console.log(JSON.stringify(status, null, 2));
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
