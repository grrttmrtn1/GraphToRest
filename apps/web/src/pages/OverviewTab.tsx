import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { FormError } from '../components/ErrorPanel';
import type { Connection } from '../types';

export function OverviewTab({ connection }: { connection: Connection }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => api.deleteConnection(connection.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
      void queryClient.invalidateQueries({ queryKey: ['mappings'] });
      navigate('/connections');
    },
  });
  return (
    <div className="panel">
      <div className="panel-header"><div><h2>Connection details</h2><p>The source configuration GraphToRest uses for this connection.</p></div></div>
      <dl>
        <dt>Adapter</dt>
        <dd>{connection.adapterType}</dd>
        <dt>Auth mode</dt>
        <dd>{connection.authMode}</dd>
        <dt>Config</dt>
        <dd>
          <code>{connection.config ? JSON.stringify(connection.config) : 'No adapter-specific config'}</code>
        </dd>
        <dt>ID</dt>
        <dd>
          <code>{connection.id}</code>
        </dd>
      </dl>
      <div className="danger-zone">
        <div><strong>Delete this connection</strong><p>This permanently removes the connection, credentials, and all of its mappings.</p></div>
        <ConfirmButton
          message={`Delete connection "${connection.name}" and all of its mappings? This cannot be undone.`}
          onConfirm={() => remove.mutate()}
          disabled={remove.isPending}
        >
          {remove.isPending ? 'Deleting…' : 'Delete connection'}
        </ConfirmButton>
      </div>
      <FormError error={remove.error} />
    </div>
  );
}
