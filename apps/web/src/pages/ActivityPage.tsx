import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorPanel } from '../components/ErrorPanel';

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
      <h1>Activity</h1>
      <label className="inline">
        <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
        Refresh every 5 seconds
      </label>
      {activity.isError ? (
        <ErrorPanel error={activity.error} onRetry={() => void activity.refetch()} />
      ) : activity.isPending ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">No requests recorded yet.</p>
      ) : (
        <>
          <table>
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
                  <td>{item.method}</td>
                  <td>
                    <code>{item.path}</code>
                  </td>
                  <td>{item.status}</td>
                  <td>{item.durationMs} ms</td>
                  <td>{item.apiKeyLabel ?? item.apiKeyId ?? '—'}</td>
                  <td>{item.connectionName ?? '—'}</td>
                  <td>{item.errorCode ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
