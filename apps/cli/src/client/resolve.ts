import { CliError } from '../errors';
import type { GtrClient, ConnectionRecord } from './types';

/** Accepts an id or a unique name. An exact id match always wins over a name match. */
export async function resolveConnection(client: GtrClient, ref: string): Promise<ConnectionRecord> {
  const connections = await client.listConnections();
  const match = connections.find((c) => c.id === ref) ?? connections.find((c) => c.name === ref);
  if (!match) throw new CliError('NOT_FOUND', `No connection with id or name "${ref}"`);
  return match;
}
