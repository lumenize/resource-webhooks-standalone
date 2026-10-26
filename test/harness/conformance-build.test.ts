// The conformance build serves the suite only when its run sets CONFORMANCE and only on
// localhost, so a deploy of it by mistake serves nothing.
import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_SECRETS } from './sign-in';

const ENVELOPE = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

function call(server: ReturnType<typeof createTestHarness>, host: string, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return server.fetch(`http://${host}/server/A/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE } }),
  });
}

function toolsList(server: ReturnType<typeof createTestHarness>, host: string) {
  return call(server, host, 'tools/list');
}

describe('with CONFORMANCE set', () => {
  const server = createTestHarness({ workers: [{ configPath: './wrangler.conformance.jsonc', vars: { CONFORMANCE: 'on' }, secrets: HARNESS_SECRETS }] });
  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("serves the suite's fixtures on localhost", async () => {
    const response = await toolsList(server, 'localhost:8788');
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(result.tools.map(({ name }) => name)).toContain('test_simple_text');
  });

  it('gives the suite no token for subscribing, so a subscribe without one answers 401', async () => {
    const subscription = { name: 'mcp.resource.updated', arguments: { uri: 'http://localhost:8788/server/A/notes/inbox/note-42' } };
    const subscribe = await call(server, 'localhost:8788', 'events/subscribe', { ...subscription, delivery: { mode: 'webhook', url: 'https://receiver.invalid/hook', secret: `whsec_${btoa('x'.repeat(32))}` }, cursor: null }, { 'Mcp-Name': subscription.name });
    expect(subscribe.status).toBe(401);
    const unsubscribe = await call(server, 'localhost:8788', 'events/unsubscribe', { ...subscription, delivery: { url: 'https://receiver.invalid/hook' } }, { 'Mcp-Name': subscription.name });
    expect(unsubscribe.status).toBe(401);
    const uri = 'http://localhost:8788/server/A/notes/inbox/note-42';
    for (const method of ['resources/webhooks/subscribe', 'resources/webhooks/unsubscribe']) {
      const response = await call(server, 'localhost:8788', method, { uri, delivery: { url: 'https://receiver.invalid/hook', secret: `whsec_${btoa('x'.repeat(32))}` } }, { 'Mcp-Name': uri });
      expect({ method, status: response.status }).toEqual({ method, status: 401 });
    }
    expect((await call(server, 'localhost:8788', 'events/list')).status).toBe(200);
  });

  it('serves nothing on any other host', async () => {
    const response = await toolsList(server, 'resource-webhooks-standalone.transformation.workers.dev');
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('This Worker serves only a local conformance run');
  });
});

describe('without CONFORMANCE', () => {
  const server = createTestHarness({ workers: [{ configPath: './wrangler.conformance.jsonc', secrets: HARNESS_SECRETS }] });
  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it('serves nothing, even on localhost', async () => {
    const response = await toolsList(server, 'localhost:8788');
    expect(response.status).toBe(403);
  });
});
