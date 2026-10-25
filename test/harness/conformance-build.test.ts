// The conformance build serves the suite only when its run sets CONFORMANCE and only on
// localhost, so a deploy of it by mistake serves nothing.
import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENVELOPE = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

function toolsList(server: ReturnType<typeof createTestHarness>, host: string) {
  return server.fetch(`http://${host}/server/A/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } }),
  });
}

describe('with CONFORMANCE set', () => {
  const server = createTestHarness({ workers: [{ configPath: './wrangler.conformance.jsonc', vars: { CONFORMANCE: 'on' } }] });
  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("serves the suite's fixtures on localhost", async () => {
    const response = await toolsList(server, 'localhost:8788');
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(result.tools.map(({ name }) => name)).toContain('test_simple_text');
  });

  it('serves nothing on any other host', async () => {
    const response = await toolsList(server, 'resource-webhooks-standalone.transformation.workers.dev');
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('This Worker serves only a local conformance run');
  });
});

describe('without CONFORMANCE', () => {
  const server = createTestHarness({ workers: [{ configPath: './wrangler.conformance.jsonc' }] });
  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it('serves nothing, even on localhost', async () => {
    const response = await toolsList(server, 'localhost:8788');
    expect(response.status).toBe(403);
  });
});
