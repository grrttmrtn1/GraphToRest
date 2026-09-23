import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { SESSION_KEY, useSession } from '../session';

export function Layout() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(SESSION_KEY, null);
      navigate('/login');
    },
  });
  return (
    <div className="layout">
      <header className="topbar">
        <span className="brand">GraphToRest</span>
        <nav>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/api-keys">API keys</NavLink>
          <NavLink to="/test">Test</NavLink>
          <NavLink to="/activity">Activity</NavLink>
        </nav>
        <span className="user">{session.data?.username}</span>
        <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Log out
        </button>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
