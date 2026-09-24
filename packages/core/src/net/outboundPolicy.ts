import dns from 'node:dns';

export type LookupFn = (hostname: string) => Promise<string[]>;

export interface OutboundPolicy {
  timeoutMs: number;
  allowPrivateNetworkTargets: boolean;
  lookup: LookupFn;
}

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;

export const systemLookup: LookupFn = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const DEFAULTS: OutboundPolicy = { timeoutMs: DEFAULT_OUTBOUND_TIMEOUT_MS, allowPrivateNetworkTargets: false, lookup: systemLookup };
let current: OutboundPolicy = { ...DEFAULTS };

/** Process-wide outbound policy (single-process deployment). Configured once at startup by the server and the CLI. */
export function getOutboundPolicy(): OutboundPolicy {
  return current;
}

export function setOutboundPolicy(patch: Partial<OutboundPolicy>): void {
  current = { ...current, ...patch };
}

export function resetOutboundPolicy(): void {
  current = { ...DEFAULTS };
}

export function outboundPolicyFromEnv(env: NodeJS.ProcessEnv): Pick<OutboundPolicy, 'timeoutMs' | 'allowPrivateNetworkTargets'> {
  let timeoutMs = DEFAULT_OUTBOUND_TIMEOUT_MS;
  const rawTimeout = env.OUTBOUND_TIMEOUT_MS;
  if (rawTimeout !== undefined && rawTimeout !== '') {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error(`OUTBOUND_TIMEOUT_MS must be an integer of at least 1, got "${rawTimeout}"`);
    }
  }
  const rawAllow = env.ALLOW_PRIVATE_NETWORK_TARGETS;
  let allowPrivateNetworkTargets = false;
  if (rawAllow !== undefined && rawAllow !== '') {
    if (rawAllow !== 'true' && rawAllow !== 'false') {
      throw new Error(`ALLOW_PRIVATE_NETWORK_TARGETS must be "true" or "false", got "${rawAllow}"`);
    }
    allowPrivateNetworkTargets = rawAllow === 'true';
  }
  return { timeoutMs, allowPrivateNetworkTargets };
}
