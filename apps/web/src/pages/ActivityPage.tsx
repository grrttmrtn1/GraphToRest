import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorPanel } from '../components/ErrorPanel';
import { PageHeader } from '../components/PageHeader';

export function ActivityPage() {
  const [autoRefresh, setAutoRefresh] = useState(false);
  const activity = useInfiniteQuery({
    queryKey: ['activity'],
    queryFn: ({ pageParam }) => api.activity(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: autoRefresh ? 5000 : false,
  });
  const items = activity.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section>
      <PageHeader
        eyebrow="Step 4 · Monitor"
        title="Activity"
        description="See recent gateway traffic, response times, and errors. Request bodies, query strings, and secrets are never recorded."
        actions={<label className="inline"><input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />Refresh every 5 seconds</label>}
      />
      {activity.isError ? (
        <ErrorPanel error={activity.error} onRetry={() => void activity.refetch()} />
      ) : activity.isPending ? (
        <p className="muted" role="status">Loading activity…</p>
      ) : items.length === 0 ? (
        <div className="empty-state"><div><strong>No requests recorded yet.</strong><p>Send a request from the API explorer and it will appear here with its status and duration.</p></div></div>
      ) : (
        <>
          <div className="table-shell"><table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Method</th>
                <th>Path</th>
                <th>Status</th>
                <th>Duration</th>
                <th>API key</th>
                <th>Connection</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.ts).toLocaleString()}</td>
                  <td><span className={`method-badge ${item.method.toLowerCase()}`}>{item.method}</span></td>
                  <td>
                    <code>{item.path}</code>
                  </td>
                  <td><span className={`status-badge ${statusTone(item.status)}`}>{item.status}</span></td>
                  <td>{item.durationMs} ms</td>
                  <td>{item.apiKeyLabel ?? item.apiKeyId ?? '—'}</td>
                  <td>{item.connectionName ?? '—'}</td>
                  <td>{item.errorCode ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {activity.hasNextPage && (
            <button type="button" onClick={() => void activity.fetchNextPage()} disabled={activity.isFetchingNextPage}>
              Load older
            </button>
          )}
        </>
      )}
    </section>
  );
}

function statusTone(status: number): string {
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warning';
  return 'success';
}
