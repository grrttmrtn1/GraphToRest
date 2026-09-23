import { ApiError } from '../api';

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'CSRF_REJECTED') {
      return `${error.message}. Check that PUBLIC_BASE_URL matches the address in your browser.`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}

export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="error-panel" role="alert">
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="form-error" role="alert">
      {errorMessage(error)}
    </p>
  );
}
