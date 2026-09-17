#!/usr/bin/env node
import { Command } from 'commander';
import { openEmbeddedStore } from './embeddedClient';
import { connectionCreate } from './commands/connectionCreate';
import { mappingCreate } from './commands/mappingCreate';
import { apiKeyCreate } from './commands/apiKeyCreate';

const program = new Command();
program.name('gtr').option('--db <path>', 'SQLite file path', process.env.DB_PATH ?? './data/graphtorest.db');

program
  .command('connection-create')
  .requiredOption('--name <name>')
  .requiredOption('--adapter-type <type>')
  .requiredOption('--auth-mode <mode>')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    console.log(JSON.stringify(connectionCreate(store, opts), null, 2));
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
  .command('apikey-create')
  .option('--label <label>')
  .action((opts) => {
    const store = openEmbeddedStore(program.opts().db);
    console.log(JSON.stringify(apiKeyCreate(store, { label: opts.label }), null, 2));
  });

program.parse();
