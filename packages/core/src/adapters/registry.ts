import type { Adapter } from './Adapter';

const registry = new Map<string, () => Adapter>();

export function registerAdapter(type: string, factory: () => Adapter): void {
  registry.set(type, factory);
}

export function createAdapter(type: string): Adapter {
  const factory = registry.get(type);
  if (!factory) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return factory();
}
