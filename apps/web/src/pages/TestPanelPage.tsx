import { lazy, Suspense, useState } from 'react';
import { readTestApiKey, storeTestApiKey } from '../testApiKey';
import { PageHeader } from '../components/PageHeader';

const SwaggerPanel = lazy(() => import('./SwaggerPanel'));

export function TestPanelPage() {
  const [apiKey, setApiKey] = useState(readTestApiKey);
  return (
    <section>
      <PageHeader eyebrow="Step 3 · Test" title="Test" description="Explore every generated route, inspect its schema, and send a real request without leaving the browser." />
      <div className="panel">
        <div className="panel-header"><div><h2>Request authentication</h2><p>Requests below go to <code>/api/*</code> exactly as a real client would send them.</p></div><span className={`status-badge ${apiKey ? 'success' : 'warning'}`}>{apiKey ? 'Key ready' : 'Key required'}</span></div>
        <label>
          API key
          <input
            aria-label="API key"
            type="password"
            value={apiKey}
            placeholder="Paste an API key"
            autoComplete="off"
            onChange={(event) => {
              setApiKey(event.target.value);
              storeTestApiKey(event.target.value);
            }}
          />
          <span className="field-hint">Stored only in this browser tab. Create a key on the API keys page if you do not have one.</span>
        </label>
      </div>
      <Suspense fallback={<p className="muted">Loading API explorer…</p>}>
        <SwaggerPanel apiKey={apiKey} />
      </Suspense>
    </section>
  );
}
