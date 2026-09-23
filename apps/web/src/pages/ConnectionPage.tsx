import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorPanel } from '../components/ErrorPanel';
import { OAuthBanner } from '../components/OAuthBanner';
import { OverviewTab } from './OverviewTab';
import { CredentialsTab } from './CredentialsTab';
import { MappingsTab } from './MappingsTab';

type Tab = 'overview' | 'credentials' | 'mappings';
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', credentials: 'Credentials', mappings: 'Mappings' };

export function ConnectionPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.has('oauth') ? 'credentials' : 'overview');
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });

  if (connections.isError) return <ErrorPanel error={connections.error} onRetry={() => void connections.refetch()} />;
  if (connections.isPending) return <p className="muted">Loading…</p>;
  const connection = connections.data.find((c) => c.id === id);
  if (!connection) {
    return (
      <section>
        <h1>Connection not found</h1>
        <Link to="/connections">Back to connections</Link>
      </section>
    );
  }
  const tabs: Tab[] = connection.authMode === 'managed' ? ['overview', 'credentials', 'mappings'] : ['overview', 'mappings'];
  const activeTab = tabs.includes(tab) ? tab : 'overview';
  return (
    <section>
      <p>
        <Link to="/connections">← Connections</Link>
      </p>
      <h1>{connection.name}</h1>
      <OAuthBanner />
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={activeTab === t} className={activeTab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      {activeTab === 'overview' && <OverviewTab connection={connection} />}
      {activeTab === 'credentials' && <CredentialsTab connection={connection} />}
      {activeTab === 'mappings' && <MappingsTab connection={connection} />}
    </section>
  );
}
