import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import { storeTestApiKey } from '../testApiKey';
import type { ApiKeySummary, CreatedApiKey, RateLimitSetting } from '../types';

function formatRateLimit(setting: RateLimitSetting): string {
  if (setting === null) return 'server default';
  if (setting === 'unlimited') return 'unlimited';
  return `${setting.requestsPerMinute}/min (burst ${setting.burst})`;
}

export function ApiKeysPage() {
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const [label, setLabel] = useState('');
  const [rate, setRate] = useState('');
  const [burst, setBurst] = useState('');
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => {
      const input: { label?: string; rateLimit?: RateLimitSetting } = {};
      if (label.trim()) input.label = label.trim();
      if (rate.trim()) {
        const requestsPerMinute = Number(rate);
        input.rateLimit = { requestsPerMinute, burst: burst.trim() ? Number(burst) : requestsPerMinute };
      }
      return api.createApiKey(input);
    },
    onSuccess: (key) => {
      setCreated(key);
      setLabel('');
      setRate('');
      setBurst('');
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteApiKey(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  const editingKey = keys.data?.find((key) => key.id === editing) ?? null;

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
          <label>
            Rate limit (requests/min, empty = server default)
            <input type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} />
          </label>
          <label>
            Burst (optional)
            <input type="number" min={1} value={burst} onChange={(e) => setBurst(e.target.value)} />
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
              <th>Rate limit</th>
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
                <td>{formatRateLimit(key.rateLimit)}</td>
                <td>{key.createdAt}</td>
                <td>{key.lastUsedAt ?? 'never'}</td>
                <td>
                  <div className="toolbar">
                    <button type="button" onClick={() => setEditing(key.id)}>
                      Edit limit
                    </button>
                    <ConfirmButton
                      message={`Revoke API key "${key.label ?? key.id}"? Clients using it will be rejected immediately.`}
                      onConfirm={() => revoke.mutate(key.id)}
                      disabled={revoke.isPending}
                    >
                      Revoke
                    </ConfirmButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <FormError error={revoke.error} />
      {editingKey && <RateLimitEditor apiKey={editingKey} onDone={() => setEditing(null)} />}
    </section>
  );
}

type RateLimitMode = 'default' | 'unlimited' | 'custom';

function modeOf(setting: RateLimitSetting): RateLimitMode {
  if (setting === null) return 'default';
  if (setting === 'unlimited') return 'unlimited';
  return 'custom';
}

/** An empty burst means "same as the rate". */
function settingFor(mode: RateLimitMode, rate: string, burst: string): RateLimitSetting {
  if (mode === 'default') return null;
  if (mode === 'unlimited') return 'unlimited';
  return { requestsPerMinute: Number(rate), burst: burst.trim() ? Number(burst) : Number(rate) };
}

function RateLimitEditor({ apiKey, onDone }: { apiKey: ApiKeySummary; onDone: () => void }) {
  const [mode, setMode] = useState<RateLimitMode>(modeOf(apiKey.rateLimit));
  const custom = typeof apiKey.rateLimit === 'object' && apiKey.rateLimit !== null ? apiKey.rateLimit : null;
  const [rate, setRate] = useState(custom ? String(custom.requestsPerMinute) : '');
  const [burst, setBurst] = useState(custom ? String(custom.burst) : '');
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.updateApiKeyRateLimit(apiKey.id, settingFor(mode, rate, burst)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      onDone();
    },
  });
  return (
    <div className="panel">
      <h2>Rate limit for {apiKey.label ?? apiKey.id}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label>
          Limit
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="default">Server default</option>
            <option value="unlimited">Unlimited</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {mode === 'custom' && (
          <>
            <label>
              Requests per minute
              <input type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} required />
            </label>
            <label>
              Burst
              <input type="number" min={1} value={burst} onChange={(e) => setBurst(e.target.value)} />
            </label>
          </>
        )}
        <FormError error={save.error} />
        <div className="toolbar">
          <button type="submit" disabled={save.isPending}>
            Save limit
          </button>
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
