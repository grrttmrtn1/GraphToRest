import { useEffect, useRef } from 'react';
import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';
import { withApiKey } from '../testApiKey';

export default function SwaggerPanel({ apiKey }: { apiKey: string }) {
  const keyRef = useRef(apiKey);
  useEffect(() => {
    keyRef.current = apiKey;
  }, [apiKey]);
  return (
    <SwaggerUI
      url="/api/openapi.json"
      requestInterceptor={(request) => Object.assign(request, withApiKey(request as { headers?: Record<string, string> }, keyRef.current))}
    />
  );
}
