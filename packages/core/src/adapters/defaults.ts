import { registerAdapter } from './registry';
import { MockAdapter } from './MockAdapter';
import { MicrosoftGraphAdapter } from './microsoftGraph/MicrosoftGraphAdapter';

export function registerDefaultAdapters(): void {
  registerAdapter('mock', () => new MockAdapter());
  registerAdapter('microsoft-graph', () => new MicrosoftGraphAdapter());
}
