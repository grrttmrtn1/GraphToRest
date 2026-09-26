import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { SESSION_KEY, useSession } from '../session';
import { Icon, type IconName } from './Icon';

const NAV_ITEMS: { to: string; label: string; helper: string; icon: IconName }[] = [
  { to: '/connections', label: 'Connections', helper: 'Connect your data', icon: 'connections' },
  { to: '/api-keys', label: 'API keys', helper: 'Control access', icon: 'key' },
  { to: '/test', label: 'API explorer', helper: 'Try an endpoint', icon: 'play' },
  { to: '/activity', label: 'Activity', helper: 'Monitor requests', icon: 'activity' },
];

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
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span className="brand-copy"><strong>GraphToRest</strong><small>API gateway</small></span>
        </div>
        <nav aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              <Icon name={item.icon} />
              <span><strong>{item.label}</strong><small>{item.helper}</small></span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="avatar" aria-hidden="true">{session.data?.username?.slice(0, 1).toUpperCase()}</span>
          <span className="user"><small>Signed in as</small><strong>{session.data?.username}</strong></span>
          <button className="icon-button" type="button" aria-label="Log out" title="Log out" onClick={() => logout.mutate()} disabled={logout.isPending}>
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <main id="main-content">
        <Outlet />
      </main>
    </div>
  );
}
