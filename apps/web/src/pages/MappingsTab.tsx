import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { downloadText } from '../browser';
import { ConfirmButton } from '../components/ConfirmButton';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import type { Connection } from '../types';
import { MappingEditForm } from './MappingEditForm';

export function summarizeOperation(operation: Record<string, unknown>): string {
  const text = JSON.stringify(operation);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function MappingsTab({ connection }: { connection: Connection }) {
  const mappings = useQuery({ queryKey: ['mappings'], queryFn: api.mappings });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [vendorToken, setVendorToken] = useState('');
  const [force, setForce] = useState(false);
  const queryClient = useQueryClient();
  const isPassthrough = connection.authMode === 'passthrough';

  const generate = useMutation({
    mutationFn: () => api.generateMappings(connection.id, { force, vendorToken: isPassthrough ? vendorToken : undefined }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['mappings'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteMapping(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['mappings'] }),
  });
  const exportYaml = useMutation({
    mutationFn: () => api.exportMappings(connection.id),
    onSuccess: (text) => downloadText(`${connection.name}-mappings.yaml`, text),
  });

  const own = (mappings.data ?? [])
    .filter((m) => m.connectionId === connection.id)
    .sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
  const editing = own.find((m) => m.id === editingId) ?? null;

  return (
    <div>
      <div className="panel">
        <h2>Generate</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            generate.mutate();
          }}
        >
          {isPassthrough && (
            <label>
              Vendor token
              <input type="password" value={vendorToken} onChange={(e) => setVendorToken(e.target.value)} autoComplete="off" required />
            </label>
          )}
          <label className="inline">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Overwrite manual mappings
          </label>
          <button type="submit" disabled={generate.isPending}>
            Generate mappings
          </button>
        </form>
        <FormError error={generate.error} />
        {generate.data && (
          <p className="success">
            Created {generate.data.created.length}, updated {generate.data.updated.length}, skipped {generate.data.skipped.length}, conflicts{' '}
            {generate.data.conflicts.length}.
          </p>
        )}
      </div>

      <div className="toolbar">
        <button type="button" onClick={() => exportYaml.mutate()} disabled={exportYaml.isPending}>
          Export YAML
        </button>
        <FormError error={exportYaml.error} />
      </div>

      {mappings.isError ? (
        <ErrorPanel error={mappings.error} onRetry={() => void mappings.refetch()} />
      ) : mappings.isPending ? (
        <p className="muted">Loading…</p>
      ) : own.length === 0 ? (
        <p className="muted">No mappings for this connection yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Method</th>
              <th>Route</th>
              <th>Source</th>
              <th>Operation</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {own.map((m) => (
              <tr key={m.id} className={m.id === editingId ? 'selected' : ''}>
                <td>{m.method}</td>
                <td>
                  <button type="button" className="link" onClick={() => setEditingId(m.id)}>
                    {m.route}
                  </button>
                </td>
                <td>{m.source}</td>
                <td>
                  <code>{summarizeOperation(m.operation)}</code>
                </td>
                <td>
                  <ConfirmButton message={`Delete mapping ${m.method} ${m.route}?`} onConfirm={() => remove.mutate(m.id)} disabled={remove.isPending}>
                    Delete
                  </ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <FormError error={remove.error} />
      {editing && <MappingEditForm key={editing.id} mapping={editing} onDone={() => setEditingId(null)} />}
    </div>
  );
}
