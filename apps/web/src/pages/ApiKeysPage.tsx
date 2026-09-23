import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import { storeTestApiKey } from '../testApiKey';
import type { CreatedApiKey } from '../types';

export function ApiKeysPage() {
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.createApiKey(label.trim() || undefined),
    onSuccess: (key) => {
      setCreated(key);
      setLabel('');
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteApiKey(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  return (
    <section>
      <h1>API keys</h1>
      {created && (
        <div className="panel highlight" role="status">
          <p>Copy this key now. It will not be shown again.</p>
          <code className="secret">{created.plaintext}</code>
          <div className="toolbar">
            <button type="button" onClick={() => void navigator.clipboard?.writeText(created.plaintext)}>
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                storeTestApiKey(created.plaintext);
                navigate('/test');
              }}
            >
              Use in test panel
            </button>
            <button type="button" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      <div className="panel">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <label>
            Label (optional)
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <FormError error={create.error} />
          <button type="submit" disabled={create.isPending}>
            Create API key
          </button>
        </form>
      </div>
      {keys.isError ? (
        <ErrorPanel error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.isPending ? (
        <p className="muted">Loading…</p>
      ) : keys.data.length === 0 ? (
        <p className="muted">No API keys yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>ID</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.data.map((key) => (
              <tr key={key.id}>
                <td>{key.label ?? '—'}</td>
                <td>
                  <code>{key.id}</code>
                </td>
                <td>{key.createdAt}</td>
                <td>{key.lastUsedAt ?? 'never'}</td>
                <td>
                  <ConfirmButton
                    message={`Revoke API key "${key.label ?? key.id}"? Clients using it will be rejected immediately.`}
                    onConfirm={() => revoke.mutate(key.id)}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <FormError error={revoke.error} />
    </section>
  );
}
