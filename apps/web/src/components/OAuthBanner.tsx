import { useSearchParams } from 'react-router-dom';

/** Shows the result the OAuth callback redirect put in the query string (?oauth=success|error&code=...). */
export function OAuthBanner() {
  const [params] = useSearchParams();
  const result = params.get('oauth');
  if (result === 'success') {
    return (
      <p className="success" role="status">
        Authorization completed.
      </p>
    );
  }
  if (result === 'error') {
    return (
      <p className="form-error" role="alert">
        Authorization failed ({params.get('code') ?? 'UNKNOWN'}).
      </p>
    );
  }
  return null;
}
