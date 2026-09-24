export const REDACTED = '[redacted]';

const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const LONG_TOKEN = /[A-Za-z0-9._~+/=-]{32,}/g;

/** Scrubs token-like content from vendor-supplied text, then truncates it, before it reaches an error or a log. */
export function redactVendorText(text: string, maxLength = 200): string {
  const scrubbed = String(text).replace(JWT, REDACTED).replace(LONG_TOKEN, REDACTED);
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed;
}
