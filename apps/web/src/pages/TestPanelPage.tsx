import { lazy, Suspense, useState } from 'react';
import { readTestApiKey, storeTestApiKey } from '../testApiKey';

const SwaggerPanel = lazy(() => import('./SwaggerPanel'));

export function TestPanelPage() {
  const [apiKey, setApiKey] = useState(readTestApiKey);
  return (
    <section>
      <h1>Test</h1>
      <label>
        API key
        <input
          type="password"
          value={apiKey}
          autoComplete="off"
          onChange={(event) => {
            setApiKey(event.target.value);
            storeTestApiKey(event.target.value);
          }}
        />
      </label>
      <p className="muted">Requests below go to /api/* with this key, exactly as a real client would send them. Create keys on the API keys page.</p>
      <Suspense fallback={<p className="muted">Loading API explorer…</p>}>
        <SwaggerPanel apiKey={apiKey} />
      </Suspense>
    </section>
  );
}
