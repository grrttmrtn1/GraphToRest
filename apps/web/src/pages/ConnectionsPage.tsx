import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { readFileText } from '../browser';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import { OAuthBanner } from '../components/OAuthBanner';

export function ConnectionsPage() {
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  return (
    <section>
      <h1>Connections</h1>
      <OAuthBanner />
      {connections.isError ? (
        <ErrorPanel error={connections.error} onRetry={() => void connections.refetch()} />
      ) : connections.isPending ? (
        <p className="muted">Loading…</p>
      ) : connections.data.length === 0 ? (
        <p className="muted">No connections yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Adapter</th>
              <th>Auth mode</th>
            </tr>
          </thead>
          <tbody>
            {connections.data.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/connections/${c.id}`}>{c.name}</Link>
                </td>
                <td>{c.adapterType}</td>
                <td>{c.authMode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CreateConnectionForm />
      <ImportMappingsForm />
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
      <h2>New connection</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Adapter
          <select value={selectedAdapter} onChange={(e) => setAdapterType(e.target.value)}>
            {(adapters.data ?? []).map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label>
          Auth mode
          <select value={authMode} onChange={(e) => setAuthMode(e.target.value)}>
            <option value="passthrough">passthrough</option>
            <option value="managed">managed</option>
          </select>
        </label>
        {selectedAdapter === 'graphql' && (
          <label>
            GraphQL endpoint URL
            <input type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} required />
          </label>
        )}
        <FormError error={create.error ?? adapters.error} />
        <button type="submit" disabled={create.isPending || !selectedAdapter}>
          Create connection
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
      <h2>Import mappings from YAML</h2>
      <p className="muted">Uses the same format as <code>gtr mapping-export</code>. Nothing is written if any entry is invalid.</p>
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
