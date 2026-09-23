import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError } from './api';
import { ErrorPanel } from './components/ErrorPanel';
import type { Session } from './types';

export const SESSION_KEY = ['session'] as const;

export function useSession() {
  return useQuery<Session | null>({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      try {
        return await api.session();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <p className="muted">Loading…</p>;
  if (session.isError) return <ErrorPanel error={session.error} onRetry={() => void session.refetch()} />;
  if (!session.data) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}
