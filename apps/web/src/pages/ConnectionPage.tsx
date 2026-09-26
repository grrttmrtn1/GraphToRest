import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorPanel } from '../components/ErrorPanel';
import { OAuthBanner } from '../components/OAuthBanner';
import { OverviewTab } from './OverviewTab';
import { CredentialsTab } from './CredentialsTab';
import { MappingsTab } from './MappingsTab';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';

type Tab = 'overview' | 'credentials' | 'mappings';
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', credentials: 'Credentials', mappings: 'Endpoints' };

export function ConnectionPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.has('oauth') ? 'credentials' : 'overview');
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });

  if (connections.isError) return <ErrorPanel error={connections.error} onRetry={() => void connections.refetch()} />;
  if (connections.isPending) return <p className="muted" role="status">Loading connection…</p>;
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
      <Link className="back-link" to="/connections"><Icon name="chevron-left" /> All connections</Link>
      <PageHeader
        eyebrow="Connection"
        title={connection.name}
        description="Manage how this source authenticates and which REST endpoints it exposes."
        actions={<><span className="badge">{connection.adapterType === 'microsoft-graph' ? 'Microsoft Graph' : connection.adapterType}</span><span className="badge accent">{connection.authMode}</span></>}
      />
      <OAuthBanner />
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={activeTab === t} className={activeTab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {activeTab === 'overview' && <OverviewTab connection={connection} />}
        {activeTab === 'credentials' && <CredentialsTab connection={connection} />}
        {activeTab === 'mappings' && <MappingsTab connection={connection} />}
      </div>
    </section>
  );
}
