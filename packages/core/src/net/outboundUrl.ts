import net from 'node:net';
import { GatewayError } from '../gateway/errors';
import { isPrivateAddress } from './ipRanges';
import { getOutboundPolicy, type OutboundPolicy } from './outboundPolicy';

function invalid(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message, 400);
}

function blocked(message: string): GatewayError {
  return new GatewayError('OUTBOUND_TARGET_BLOCKED', message, 502);
}

/** Write-time URL validation for admin-supplied outbound URLs. Returns the trimmed URL. */
export function assertOutboundUrlShape(value: unknown, field: string, options: { httpsOnly?: boolean } = {}): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid(`"${field}" is required`);
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid(`"${field}" must be a valid URL`);
  }
  if (options.httpsOnly && url.protocol !== 'https:') throw invalid(`"${field}" must be an https URL`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid(`"${field}" must be an http or https URL`);
  if (url.username || url.password) throw invalid(`"${field}" must not contain a username or password`);
  return text;
}

/**
 * Request-time destination check. Resolves the host and refuses private-network destinations unless the policy opts
 * in; plain http is allowed only for opted-in private destinations. Known gap: DNS may change between this check and
 * the connection (rebinding) — see the Plan 8 spec §5.5.
 */
export async function assertOutboundTargetAllowed(url: string, policy: OutboundPolicy = getOutboundPolicy()): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid('Invalid outbound URL');
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await policy.lookup(host);
    } catch (err) {
      throw new GatewayError('VENDOR_UNREACHABLE', `Could not resolve ${host}`, 502, { message: (err as Error).message });
    }
    if (addresses.length === 0) throw new GatewayError('VENDOR_UNREACHABLE', `Could not resolve ${host}`, 502);
  }
  // Fail closed on the block check: any private address in the answer is enough to refuse, even with a public
  // address mixed in, unless the deployment opted in.
  const privateTarget = addresses.some(isPrivateAddress);
  if (privateTarget && !policy.allowPrivateNetworkTargets) {
    throw blocked(`${host} resolves to a private-network address; set ALLOW_PRIVATE_NETWORK_TARGETS=true to allow it`);
  }
  // The http rule is the opposite: plain http is only safe when EVERY resolved address is private, because the
  // actual TCP connection could land on any of them. `some` here would let a mixed public/private DNS answer send
  // plain http to what may resolve to the public address.
  const allPrivate = addresses.every(isPrivateAddress);
  if (parsed.protocol === 'http:' && !allPrivate) {
    throw blocked(`Plain http is only allowed for private-network destinations (with ALLOW_PRIVATE_NETWORK_TARGETS=true); use https for ${host}`);
  }
}

/**
 * fetch() for admin-configured destinations: destination check, policy timeout, and no redirects unless `init` says
 * otherwise. A caller-supplied signal is combined with the policy timeout, never a replacement for it.
 */
export async function outboundFetch(url: string, init: RequestInit = {}, policy: OutboundPolicy = getOutboundPolicy()): Promise<Response> {
  await assertOutboundTargetAllowed(url, policy);
  const timeout = AbortSignal.timeout(policy.timeoutMs);
  return fetch(url, { redirect: 'error', ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
}
