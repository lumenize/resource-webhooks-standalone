// A token for A's MCP endpoint, got through the real OAuth flow against a Worker under
// wrangler's test harness, the way any client gets one.
import type { createTestHarness } from 'wrangler';
import { OAuthSession } from '../../src/client/mcp-client';

/** The signing secret the harness Workers run with, for tests only. */
export const HARNESS_SECRETS = { TOKEN_SIGNING_KEY: 'test-signing-key-for-the-harness-only' };

export function signIn(server: ReturnType<typeof createTestHarness>, origin: string, instance = 'A'): Promise<string> {
  // The harness answers with Node's Response, which the client reads the same way.
  const send = ((input: RequestInfo | URL, init?: RequestInit) =>
    server.fetch(String(input instanceof Request ? input.url : input), init as never)) as unknown as typeof fetch;
  const session = new OAuthSession({ redirectUri: `${origin}/callback`, fetch: send });
  return session.tokenFor(`${origin}/server/${instance}/mcp`);
}
