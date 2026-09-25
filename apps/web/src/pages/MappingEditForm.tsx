import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { FormError } from '../components/ErrorPanel';
import type { Mapping, MappingPatch } from '../types';

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function MappingEditForm({ mapping, onDone }: { mapping: Mapping; onDone: () => void }) {
  const [method, setMethod] = useState(mapping.method);
  const [route, setRoute] = useState(mapping.route);
  const [operation, setOperation] = useState(JSON.stringify(mapping.operation, null, 2));
  const [template, setTemplate] = useState(mapping.responseTemplate ? JSON.stringify(mapping.responseTemplate, null, 2) : '');
  const [cacheTtl, setCacheTtl] = useState(String(mapping.cacheTtlSeconds ?? 0));
  const [localError, setLocalError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: MappingPatch) => api.updateMapping(mapping.id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mappings'] });
      onDone();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    const parsedOperation = parseJson(operation);
    if (!parsedOperation.ok) {
      setLocalError(`Operation is not valid JSON: ${parsedOperation.error}`);
      return;
    }
    let responseTemplate: unknown = null;
    if (template.trim()) {
      const parsedTemplate = parseJson(template);
      if (!parsedTemplate.ok) {
        setLocalError(`Response template is not valid JSON: ${parsedTemplate.error}`);
        return;
      }
      responseTemplate = parsedTemplate.value;
    }
    const ttl = Number(cacheTtl);
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 86_400) {
      setLocalError('Cache TTL must be a whole number of seconds from 0 to 86400');
      return;
    }
    // Send only the fields that actually changed: the server treats a present route/method/operation/
    // responseTemplate as a definitional edit and flips the mapping to "manual", so re-sending an unchanged
    // field (as a TTL-only edit otherwise would) must not happen.
    const cacheTtlSeconds = ttl === 0 ? null : ttl;
    const patch: MappingPatch = {};
    if (method !== mapping.method) patch.method = method;
    if (route !== mapping.route) patch.route = route;
    if (JSON.stringify(parsedOperation.value) !== JSON.stringify(mapping.operation)) patch.operation = parsedOperation.value;
    if (JSON.stringify(responseTemplate) !== JSON.stringify(mapping.responseTemplate ?? null)) patch.responseTemplate = responseTemplate;
    if (cacheTtlSeconds !== (mapping.cacheTtlSeconds ?? null)) patch.cacheTtlSeconds = cacheTtlSeconds;
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    save.mutate(patch);
  };

  return (
    <div className="panel">
      <h2>
        Edit {mapping.method} {mapping.route}
      </h2>
      <p className="muted">Saving marks this mapping as manual, so regeneration skips it unless forced.</p>
      <form onSubmit={submit}>
        <label>
          Method
          <input value={method} onChange={(e) => setMethod(e.target.value)} required />
        </label>
        <label>
          Route
          <input value={route} onChange={(e) => setRoute(e.target.value)} required />
        </label>
        <label>
          Operation (JSON)
          <textarea value={operation} onChange={(e) => setOperation(e.target.value)} />
        </label>
        <label>
          Response template (JSON, empty for passthrough)
          <textarea value={template} onChange={(e) => setTemplate(e.target.value)} />
        </label>
        <label>
          Cache TTL (seconds, 0 = off)
          <input type="number" min={0} max={86400} step="any" value={cacheTtl} onChange={(e) => setCacheTtl(e.target.value)} />
        </label>
        {localError && (
          <p className="form-error" role="alert">
            {localError}
          </p>
        )}
        <FormError error={save.error} />
        <div className="toolbar">
          <button type="submit" disabled={save.isPending}>
            Save mapping
          </button>
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
