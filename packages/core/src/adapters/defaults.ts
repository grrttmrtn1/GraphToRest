import { registerAdapter } from './registry';
import { MockAdapter } from './MockAdapter';
import { MicrosoftGraphAdapter } from './microsoftGraph/MicrosoftGraphAdapter';
import { GraphQLAdapter } from './graphql/GraphQLAdapter';

export function registerDefaultAdapters(): void {
  registerAdapter('mock', () => new MockAdapter());
  registerAdapter('microsoft-graph', () => new MicrosoftGraphAdapter());
  registerAdapter('graphql', () => new GraphQLAdapter());
}
