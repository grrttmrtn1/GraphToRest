import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { FormError } from '../components/ErrorPanel';
import { SESSION_KEY } from '../session';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/connections';
  const login = useMutation({
    mutationFn: () => api.login(username, password),
    onSuccess: (session) => {
      queryClient.setQueryData(SESSION_KEY, session);
      navigate(from, { replace: true });
    },
  });
  return (
    <div className="login-page">
      <div className="login-intro">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span className="brand-copy"><strong>GraphToRest</strong><small>API gateway</small></span>
        </div>
        <div className="login-pitch">
          <p className="eyebrow">One gateway. Any graph.</p>
          <h2>Turn complex GraphQL into clean REST.</h2>
          <p>Connect a data source, generate predictable endpoints, and give your team a familiar API in minutes.</p>
        </div>
        <span className="login-proof">Self-hosted · Your infrastructure · Your data</span>
      </div>
      <div className="login-form-wrap">
        <div className="login">
          <h1>GraphToRest</h1>
          <p className="page-description">Sign in to manage your gateway.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              login.mutate();
            }}
          >
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </label>
            <FormError error={login.error} />
            <button type="submit" disabled={login.isPending}>
              {login.isPending ? 'Signing in…' : 'Log in'}
            </button>
          </form>
          <p className="first-run">
            Setting up for the first time? Create an admin account on the server with <code>gtr admin create --username &lt;name&gt;</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
