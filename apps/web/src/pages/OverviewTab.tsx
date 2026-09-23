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
      <dl>
        <dt>Adapter</dt>
        <dd>{connection.adapterType}</dd>
        <dt>Auth mode</dt>
        <dd>{connection.authMode}</dd>
        <dt>Config</dt>
        <dd>
          <code>{connection.config ? JSON.stringify(connection.config) : 'none'}</code>
        </dd>
        <dt>ID</dt>
        <dd>
          <code>{connection.id}</code>
        </dd>
      </dl>
      <ConfirmButton
        message={`Delete connection "${connection.name}" and all of its mappings? This cannot be undone.`}
        onConfirm={() => remove.mutate()}
        disabled={remove.isPending}
      >
        Delete connection
      </ConfirmButton>
      <FormError error={remove.error} />
    </div>
  );
}
