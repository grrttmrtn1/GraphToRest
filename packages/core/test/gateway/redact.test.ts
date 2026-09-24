import { describe, it, expect } from 'vitest';
import { redactVendorText } from '../../src/gateway/redact';

describe('redactVendorText', () => {
  it('leaves ordinary text alone', () => {
    expect(redactVendorText('Client authentication failed')).toBe('Client authentication failed');
  });
  it('redacts JWT-shaped strings', () => {
    expect(redactVendorText('bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-part here')).toBe('bad token [redacted] here');
  });
  it('redacts long token-like runs', () => {
    // The "secret=" prefix is itself composed of token-charset characters (letters + "="),
    // so it joins the same contiguous run as the value and is redacted along with it.
    const secret = 'A'.repeat(20) + 'b1-._~+/=' + 'C'.repeat(10);
    expect(redactVendorText(`secret=${secret} end`)).toBe('[redacted] end');
  });
  it('keeps runs shorter than 32 characters', () => {
    expect(redactVendorText('id 0123456789abcdef0123456789abcde')).toBe('id 0123456789abcdef0123456789abcde');
  });
  it('truncates after redacting', () => {
    const out = redactVendorText('word '.repeat(100));
    expect(out.length).toBe(201);
    expect(out.endsWith('…')).toBe(true);
    expect(redactVendorText('abc', 2)).toBe('ab…');
  });
});
