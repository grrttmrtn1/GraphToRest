import type { Connection } from '../types';

export function MappingsTab({ connection }: { connection: Connection }) {
  return <p className="muted">Mappings for {connection.name}.</p>;
}
