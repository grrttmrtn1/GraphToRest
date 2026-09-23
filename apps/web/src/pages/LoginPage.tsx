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
    <div className="login">
      <h1>GraphToRest</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate();
        }}
      >
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <FormError error={login.error} />
        <button type="submit" disabled={login.isPending}>
          Log in
        </button>
      </form>
      <p className="muted">
        First time? Create an admin account on the server with <code>gtr admin-create --username &lt;name&gt;</code>.
      </p>
    </div>
  );
}
