import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { downloadText, readFileText } from '../browser';
import { ConfirmButton } from '../components/ConfirmButton';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import type { Connection } from '../types';
import { MappingEditForm } from './MappingEditForm';
import { Icon } from '../components/Icon';

export function summarizeOperation(operation: Record<string, unknown>): string {
  const text = JSON.stringify(operation);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function adapterDescription(adapterType: string): string {
  if (adapterType === 'graphql') {
    return 'Inspect the GraphQL schema for supported queries, then publish them as simple REST endpoints.';
  }
  if (adapterType === 'microsoft-graph') {
    return 'Load GraphToRest\'s supported Microsoft Graph operations, then publish them as simpler REST endpoints.';
  }
  return 'Ask this connection\'s adapter for the upstream operations it can publish as REST endpoints.';
}

function discoveryProgress(adapterType: string): string {
  if (adapterType === 'graphql') return 'Inspecting GraphQL schema…';
  if (adapterType === 'microsoft-graph') return 'Loading Graph operations…';
  return 'Discovering operations…';
}

function sourceSchemaDescription(adapterType: string): string {
  if (adapterType === 'graphql') {
    return 'GraphToRest reads the introspection schema from the configured GraphQL endpoint; you do not upload a Swagger file.';
  }
  if (adapterType === 'microsoft-graph') {
    return 'GraphToRest uses its curated set of supported Microsoft Graph operations; you do not upload a Swagger file.';
  }
  return 'The connection adapter supplies the upstream operations; you do not upload a Swagger file.';
}

function yamlOperationExample(adapterType: string): string[] {
  if (adapterType === 'microsoft-graph') return ['    kind: get', '    path: /users/{id}'];
  return [
    '    query: "query($id: ID!) { user(id: $id) { id name } }"',
    '    variables:',
    '      id: $params.id',
  ];
}

export function mappingYamlExample(connection: Pick<Connection, 'name' | 'adapterType'>): string {
  return [
    '- route: GET /users/{id}',
    `  connection: ${JSON.stringify(connection.name)}`,
    '  source: manual',
    '  operation:',
    ...yamlOperationExample(connection.adapterType),
    '  response:',
    '    shape: template',
    '    template:',
    `      id: '${connection.adapterType === 'graphql' ? '$.user.id' : '$.id'}'`,
    '  auth: inherit',
    '  cacheTtlSeconds: 60',
  ].join('\n');
}

export function MappingsTab({ connection }: { connection: Connection }) {
  const mappings = useQuery({ queryKey: ['mappings'], queryFn: api.mappings });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [vendorToken, setVendorToken] = useState('');
  const [force, setForce] = useState(false);
  const [showImport, setShowImport] = useState(false);
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
  const importYaml = useMutation({
    mutationFn: async (file: File) => api.importMappings(await readFileText(file)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['mappings'] }),
  });

  const own = (mappings.data ?? [])
    .filter((m) => m.connectionId === connection.id)
    .sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
  const editing = own.find((m) => m.id === editingId) ?? null;

  return (
    <div>
      <div className="panel mapping-guide">
        <div className="panel-header">
          <div>
            <h2>How REST endpoints are created</h2>
            <p>GraphToRest discovers supported upstream operations and gives each one a simpler REST route. The saved recipe behind an endpoint is called a mapping.</p>
          </div>
        </div>
        <ol className="mapping-flow">
          <li><span className="step-number">1</span><div><strong>Discover upstream operations</strong><p>Inspect this connection below, or import endpoints from a previously exported YAML file.</p></div></li>
          <li><span className="step-number">2</span><div><strong>Match a REST request</strong><p><code>GET /users/{'{id}'}</code> is exposed at <code>/api/users/{'{id}'}</code> and captures <code>id</code> from the URL.</p></div></li>
          <li><span className="step-number">3</span><div><strong>Call and shape upstream</strong><p>The operation is adapter-specific JSON. The optional response template picks fields using paths such as <code>$.user.id</code>.</p></div></li>
        </ol>
        <div className="schema-note">
          <strong>Where does the schema come from?</strong>
          <p>{sourceSchemaDescription(connection.adapterType)} After endpoints are published, GraphToRest automatically generates its own OpenAPI document for the API explorer.</p>
        </div>
        <details className="mapping-reference">
          <summary>View field reference and YAML example</summary>
          <div className="reference-grid">
            <div>
              <h3>What each field means</h3>
              <dl className="compact-definitions">
                <dt>Route</dt><dd>HTTP method plus a path beginning with <code>/</code>. Use <code>{'{name}'}</code> for a path parameter.</dd>
                <dt>Operation</dt><dd>JSON understood by the connection adapter: a GraphQL query and variables, or a Microsoft Graph <code>get</code>, <code>list</code>, or <code>batch</code> operation.</dd>
                <dt>Response</dt><dd>Pass through the upstream body, or return a flat object whose values come from <code>$.</code>-prefixed field paths.</dd>
                <dt>Source</dt><dd><code>generated</code> can be refreshed. Editing a route, operation, or response marks it <code>manual</code>, which generation protects unless overwrite is selected.</dd>
              </dl>
            </div>
            <div>
              <h3>Importable YAML</h3>
              <p>Export first for the safest template, edit the file, then import it. Remove <code>id</code> from an export to create a new mapping.</p>
              <pre><code>{mappingYamlExample(connection)}</code></pre>
              <p className="field-hint"><code>connection</code> must exactly match an existing connection name, and <code>auth</code> must be <code>inherit</code>. Imports are all-or-nothing.</p>
            </div>
          </div>
        </details>
      </div>

      <div className="panel">
        <div className="panel-header"><div><h2>Create REST endpoints</h2><p>{adapterDescription(connection.adapterType)} Existing manual changes are protected by default.</p></div><Icon name="sparkles" /></div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            generate.mutate();
          }}
        >
          {isPassthrough && (
            <label>
              Vendor token
              <input aria-label="Vendor token" type="password" value={vendorToken} onChange={(e) => setVendorToken(e.target.value)} placeholder="Paste a temporary upstream token" autoComplete="off" required />
              <span className="field-hint">Used only for this discovery request. It is not stored.</span>
            </label>
          )}
          <label className="inline">
            <input aria-label="Overwrite manual mappings" type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Overwrite manual mappings <span className="muted">(use with care)</span>
          </label>
          <button type="submit" disabled={generate.isPending}>
            <Icon name="sparkles" /> {generate.isPending ? discoveryProgress(connection.adapterType) : 'Discover and create endpoints'}
          </button>
        </form>
        <FormError error={generate.error} />
        {generate.data && (
          <p className="success">
            Endpoints: {generate.data.created.length} created, {generate.data.updated.length} updated, {generate.data.skipped.length} skipped,{' '}
            {generate.data.conflicts.length} conflicts.
          </p>
        )}
      </div>

      <div className="panel-header">
        <div><h2>Published REST endpoints</h2><p>Each endpoint connects a public REST route to an upstream operation. Select a route to view or customize its mapping.</p></div>
        <div className="toolbar">
          <button type="button" onClick={() => setShowImport((visible) => !visible)} aria-expanded={showImport}>
            <Icon name="upload" /> Import YAML
          </button>
          <button type="button" onClick={() => exportYaml.mutate()} disabled={exportYaml.isPending}>Export YAML</button>
        </div>
      </div>
      <FormError error={exportYaml.error} />
      {showImport && (
        <div className="panel import-panel">
          <div className="panel-header">
            <div>
              <h2>Import endpoints from YAML</h2>
              <p>Upload a GraphToRest export or a UTF-8 YAML file containing a list of endpoint mappings in this format:</p>
            </div>
          </div>
          <div className="import-grid">
            <pre><code>{mappingYamlExample(connection)}</code></pre>
            <div className="import-rules">
              <strong>Before importing</strong>
              <ul>
                <li><code>connection</code> must exactly match an existing connection name.</li>
                <li><code>route</code> combines the HTTP method and path.</li>
                <li><code>operation</code> is adapter-specific; <code>response</code> is either <code>passthrough</code> or a template.</li>
                <li>An exported entry with <code>id</code> updates that endpoint. Without <code>id</code>, it creates one.</li>
                <li>Imported endpoints become manual. The whole file is rejected if any entry is invalid.</li>
              </ul>
              <label>
                Choose YAML file
                <input
                  type="file"
                  accept=".yaml,.yml,text/yaml"
                  aria-label="Import mappings YAML"
                  disabled={importYaml.isPending}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) importYaml.mutate(file);
                    event.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>
          <FormError error={importYaml.error} />
          {importYaml.data && <p className="success">Imported {importYaml.data.imported} mapping(s).</p>}
          {importYaml.data?.warnings.map((warning) => <p key={warning} className="warning">{warning}</p>)}
        </div>
      )}

      {mappings.isError ? (
        <ErrorPanel error={mappings.error} onRetry={() => void mappings.refetch()} />
      ) : mappings.isPending ? (
        <p className="muted">Loading…</p>
      ) : own.length === 0 ? (
        <div className="empty-state compact"><div><strong>No REST endpoints for this connection yet.</strong><p>Discover supported upstream operations above to create them.</p></div></div>
      ) : (
        <div className="table-shell"><table>
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
                <td><span className={`method-badge ${m.method.toLowerCase()}`}>{m.method}</span></td>
                <td>
                  <button type="button" className="link" onClick={() => setEditingId(m.id)}>
                    {m.route}
                  </button>
                </td>
                <td><span className={`badge ${m.source === 'generated' ? 'accent' : 'warning'}`}>{m.source}</span></td>
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
        </table></div>
      )}
      <FormError error={remove.error} />
      {editing && <MappingEditForm key={editing.id} mapping={editing} adapterType={connection.adapterType} onDone={() => setEditingId(null)} />}
    </div>
  );
}
