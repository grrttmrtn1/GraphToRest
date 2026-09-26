import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { readFileText } from '../browser';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import { OAuthBanner } from '../components/OAuthBanner';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';

export function ConnectionsPage() {
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  return (
    <section>
      <PageHeader eyebrow="Step 1 · Connect" title="Connections" description="Link GraphToRest to the GraphQL services you want to expose as straightforward REST endpoints." />
      <OAuthBanner />
      <div className="content-grid">
        <div>
          <div className="panel-header">
            <div><h2>Your data sources</h2><p>Open a connection to configure credentials and REST mappings.</p></div>
          </div>
          {connections.isError ? (
            <ErrorPanel error={connections.error} onRetry={() => void connections.refetch()} />
          ) : connections.isPending ? (
            <p className="muted" role="status">Loading connections…</p>
          ) : connections.data.length === 0 ? (
            <div className="empty-state"><div><strong>No connections yet.</strong><p>Create your first connection using the form. You can generate REST mappings immediately afterward.</p></div></div>
          ) : (
            <div className="table-shell">
              <table>
                <thead><tr><th>Name</th><th>Adapter</th><th>Authentication</th><th aria-label="Open" /></tr></thead>
                <tbody>
                  {connections.data.map((c) => (
                    <tr key={c.id}>
                      <td><div className="cell-title"><Link to={`/connections/${c.id}`}>{c.name}</Link><small>{c.id}</small></div></td>
                      <td><span className="badge">{friendlyAdapter(c.adapterType)}</span></td>
                      <td><span className={`badge ${c.authMode === 'managed' ? 'accent' : ''}`}>{friendlyAuth(c.authMode)}</span></td>
                      <td><Link to={`/connections/${c.id}`} aria-label={`Open ${c.name}`}><Icon name="arrow-right" /></Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="stack">
          <CreateConnectionForm />
          <ImportMappingsForm />
          <div className="panel">
            <div className="panel-header"><div><h2>How setup works</h2><p>A quick path from data source to working endpoint.</p></div></div>
            <ol className="step-list">
              <li><span className="step-number">1</span><div><strong>Connect a source</strong><p>Choose an adapter and how upstream authentication should work.</p></div></li>
              <li><span className="step-number">2</span><div><strong>Generate mappings</strong><p>Discover operations and turn them into REST routes.</p></div></li>
              <li><span className="step-number">3</span><div><strong>Create an API key</strong><p>Give clients controlled access, then try the API explorer.</p></div></li>
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

function CreateConnectionForm() {
  const adapters = useQuery({ queryKey: ['adapters'], queryFn: api.adapters });
  const [name, setName] = useState('');
  const [adapterType, setAdapterType] = useState('');
  const [authMode, setAuthMode] = useState('passthrough');
  const [endpoint, setEndpoint] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const selectedAdapter = adapterType || adapters.data?.[0] || '';
  const create = useMutation({
    mutationFn: () =>
      api.createConnection({
        name,
        adapterType: selectedAdapter,
        authMode,
        ...(selectedAdapter === 'graphql' ? { config: { endpoint } } : {}),
      }),
    onSuccess: (connection) => {
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
      navigate(`/connections/${connection.id}`);
    },
  });
  return (
    <div className="panel">
      <div className="panel-header"><div><h2>New connection</h2><p>Start by choosing the kind of source you want to connect.</p></div></div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Name
          <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Customer directory" required />
          <span className="field-hint">A friendly name your team will recognize.</span>
        </label>
        <label>
          Adapter
          <select value={selectedAdapter} onChange={(e) => setAdapterType(e.target.value)}>
            {(adapters.data ?? []).map((type) => (
              <option key={type} value={type}>
                {friendlyAdapter(type)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Auth mode
          <select value={authMode} onChange={(e) => setAuthMode(e.target.value)}>
            <option value="passthrough">Pass through client token</option>
            <option value="managed">Managed by gateway</option>
          </select>
          <span className="field-hint">{authMode === 'managed' ? 'GraphToRest stores credentials and authenticates upstream.' : 'Each request supplies its own upstream access token.'}</span>
        </label>
        {selectedAdapter === 'graphql' && (
          <label>
            GraphQL endpoint URL
            <input type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.example.com/graphql" required />
          </label>
        )}
        <FormError error={create.error ?? adapters.error} />
        <button type="submit" disabled={create.isPending || !selectedAdapter}>
          <Icon name="plus" /> {create.isPending ? 'Creating…' : 'Create connection'}
        </button>
      </form>
    </div>
  );
}

function ImportMappingsForm() {
  const queryClient = useQueryClient();
  const importMutation = useMutation({
    mutationFn: async (file: File) => api.importMappings(await readFileText(file)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['mappings'] }),
  });
  return (
    <div className="panel">
      <div className="panel-header"><div><h2>Import mappings</h2><p>Already have an export? Upload it instead of generating routes again.</p></div><Icon name="upload" /></div>
      <input
        type="file"
        accept=".yaml,.yml,text/yaml"
        aria-label="YAML file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) importMutation.mutate(file);
          event.target.value = '';
        }}
      />
      <FormError error={importMutation.error} />
      {importMutation.data && <p className="success">Imported {importMutation.data.imported} mapping(s).</p>}
      {importMutation.data?.warnings.map((warning) => (
        <p key={warning} className="warning">
          {warning}
        </p>
      ))}
    </div>
  );
}

function friendlyAdapter(value: string): string {
  if (value === 'microsoft-graph') return 'Microsoft Graph';
  if (value === 'graphql') return 'GraphQL';
  return value === 'mock' ? 'Mock' : value;
}

function friendlyAuth(value: string): string {
  return value === 'managed' ? 'Managed' : 'Passthrough';
}
