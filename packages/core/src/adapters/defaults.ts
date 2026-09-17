import { registerAdapter } from './registry';
import { MockAdapter } from './MockAdapter';

export function registerDefaultAdapters(): void {
  registerAdapter('mock', () => new MockAdapter());
}
