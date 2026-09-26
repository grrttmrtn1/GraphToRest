import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import { storeTestApiKey } from '../testApiKey';
import type { ApiKeySummary, CreatedApiKey, RateLimitSetting } from '../types';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';

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
      <PageHeader eyebrow="Step 2 · Secure" title="API keys" description="Issue credentials for clients that call your REST gateway. You can set a per-key rate limit and revoke access at any time." />
      {created && (
        <div className="panel highlight" role="status">
          <div className="panel-header"><div><h2>Your new key is ready</h2><p>Copy this key now. It will not be shown again.</p></div><span className="status-badge success"><Icon name="check" /> Created</span></div>
          <code className="secret">{created.plaintext}</code>
          <div className="toolbar">
            <button className="primary" type="button" onClick={() => void navigator.clipboard?.writeText(created.plaintext)}>
              <Icon name="copy" /> Copy
            </button>
            <button
              type="button"
              onClick={() => {
                storeTestApiKey(created.plaintext);
                navigate('/test');
              }}
            >
              <Icon name="play" /> Use in test panel
            </button>
            <button type="button" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      <div className="content-grid">
      <div>
        <div className="panel-header"><div><h2>Active keys</h2><p>Only key IDs are stored here—the secret itself cannot be recovered.</p></div></div>
      {keys.isError ? (
        <ErrorPanel error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.isPending ? (
        <p className="muted" role="status">Loading API keys…</p>
      ) : keys.data.length === 0 ? (
        <div className="empty-state"><div><strong>No API keys yet.</strong><p>Create a key to authenticate requests to your generated REST endpoints.</p></div></div>
      ) : (
        <div className="table-shell"><table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Rate limit</th>
              <th>Created</th>
              <th>Last used</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {keys.data.map((key) => (
              <tr key={key.id}>
                <td><div className="cell-title"><strong>{key.label ?? 'Unlabelled key'}</strong><small><code>{key.id}</code></small></div></td>
                <td><span className="badge">{formatRateLimit(key.rateLimit)}</span></td>
                <td>{new Date(key.createdAt).toLocaleDateString()}</td>
                <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'never'}</td>
                <td>
                  <div className="toolbar">
                    <button type="button" onClick={() => setEditing(key.id)}>Edit limit</button>
                    <ConfirmButton
                      message={`Revoke API key "${key.label ?? key.id}"? Clients using it will be rejected immediately.`}
                      onConfirm={() => revoke.mutate(key.id)}
                      disabled={revoke.isPending}
                    >Revoke</ConfirmButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <FormError error={revoke.error} />
      {editingKey && <RateLimitEditor apiKey={editingKey} onDone={() => setEditing(null)} />}
      </div>
      <div className="panel">
        <div className="panel-header"><div><h2>Create an API key</h2><p>Use a descriptive label so you know which client owns this key.</p></div></div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <label>
            Label (optional)
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Production website" />
          </label>
          <label>
            Rate limit (requests/min, empty = server default)
            <input type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} placeholder="Server default" />
          </label>
          <label>
            Burst (optional)
            <input type="number" min={1} value={burst} onChange={(e) => setBurst(e.target.value)} placeholder={rate || 'Same as rate'} />
            <span className="field-hint">How many requests may arrive at once.</span>
          </label>
          <FormError error={create.error} />
          <button type="submit" disabled={create.isPending}>
            <Icon name="plus" /> {create.isPending ? 'Creating…' : 'Create API key'}
          </button>
        </form>
      </div>
      </div>
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
