import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { redirectBrowser } from '../browser';
import { ConfirmButton } from '../components/ConfirmButton';
import { ErrorPanel, FormError } from '../components/ErrorPanel';
import type { Connection, CredentialStatus } from '../types';

export interface CredentialForm {
  grant: 'client_credentials' | 'authorization_code';
  clientId: string;
  clientSecret: string;
  tenantId: string;
  tokenUrl: string;
  authorizeUrl: string;
  scopes: string;
}

/** Builds the PUT /credentials payload the server's parseManagedCredentials expects for this adapter. */
export function toCredentialInput(adapterType: string, form: CredentialForm): Record<string, unknown> {
  const input: Record<string, unknown> = { grant: form.grant, clientId: form.clientId, clientSecret: form.clientSecret };
  if (adapterType === 'microsoft-graph') {
    input.tenantId = form.tenantId;
  } else {
    input.tokenUrl = form.tokenUrl;
    if (form.grant === 'authorization_code') input.authorizeUrl = form.authorizeUrl;
  }
  const scopes = form.scopes.split(/\s+/).filter(Boolean);
  if (scopes.length > 0) input.scopes = scopes;
  return input;
}

function describeStatus(status: CredentialStatus): string {
  if (!status.configured) return 'No credentials stored.';
  if (status.grant === 'client_credentials') return 'Configured: client_credentials grant.';
  return `Configured: authorization_code grant, ${status.hasRefreshToken ? 'authorized' : 'not yet authorized'}.`;
}

const EMPTY_FORM: CredentialForm = {
  grant: 'client_credentials',
  clientId: '',
  clientSecret: '',
  tenantId: '',
  tokenUrl: '',
  authorizeUrl: '',
  scopes: '',
};

export function CredentialsTab({ connection }: { connection: Connection }) {
  const key = ['credentials', connection.id];
  const status = useQuery({ queryKey: key, queryFn: () => api.credentialStatus(connection.id) });
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CredentialForm>(EMPTY_FORM);
  const isMicrosoft = connection.adapterType === 'microsoft-graph';
  const update = (field: keyof CredentialForm) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  const save = useMutation({
    mutationFn: () => api.saveCredentials(connection.id, toCredentialInput(connection.adapterType, form)),
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      setForm((current) => ({ ...current, clientSecret: '' }));
    },
  });
  const clear = useMutation({
    mutationFn: () => api.clearCredentials(connection.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const authorize = useMutation({
    mutationFn: () => api.startAuthorization(connection.id),
    onSuccess: ({ authorizationUrl }) => redirectBrowser(authorizationUrl),
  });

  return (
    <div>
      <div className="panel">
        <h2>Status</h2>
        {status.isError ? (
          <ErrorPanel error={status.error} onRetry={() => void status.refetch()} />
        ) : status.isPending ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p>{describeStatus(status.data)}</p>
            <div className="toolbar">
              {status.data.configured && status.data.grant === 'authorization_code' && (
                <button type="button" onClick={() => authorize.mutate()} disabled={authorize.isPending}>
                  Authorize
                </button>
              )}
              {status.data.configured && (
                <ConfirmButton message="Clear the stored credentials for this connection?" onConfirm={() => clear.mutate()} disabled={clear.isPending}>
                  Clear credentials
                </ConfirmButton>
              )}
            </div>
            <FormError error={authorize.error ?? clear.error} />
          </>
        )}
      </div>
      <div className="panel">
        <h2>Set credentials</h2>
        <p className="muted">Secrets are encrypted on the server and never shown again.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <label>
            Grant
            <select value={form.grant} onChange={update('grant')}>
              <option value="client_credentials">client_credentials</option>
              <option value="authorization_code">authorization_code</option>
            </select>
          </label>
          <label>
            Client ID
            <input value={form.clientId} onChange={update('clientId')} required />
          </label>
          <label>
            Client secret
            <input type="password" value={form.clientSecret} onChange={update('clientSecret')} autoComplete="off" required />
          </label>
          {isMicrosoft ? (
            <label>
              Tenant ID
              <input value={form.tenantId} onChange={update('tenantId')} required />
            </label>
          ) : (
            <>
              <label>
                Token URL
                <input type="url" value={form.tokenUrl} onChange={update('tokenUrl')} required />
              </label>
              {form.grant === 'authorization_code' && (
                <label>
                  Authorize URL
                  <input type="url" value={form.authorizeUrl} onChange={update('authorizeUrl')} required />
                </label>
              )}
            </>
          )}
          <label>
            Scopes (space-separated, optional)
            <input value={form.scopes} onChange={update('scopes')} />
          </label>
          <FormError error={save.error} />
          <button type="submit" disabled={save.isPending}>
            Save credentials
          </button>
        </form>
      </div>
    </div>
  );
}
