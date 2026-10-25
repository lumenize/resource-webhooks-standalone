// Requests as they arrive over HTTP. A `Request` built in the lane has its header values
// normalized by the Fetch standard, while one that workerd parses off the wire keeps the
// whitespace around them, so these run against the Worker under wrangler's test harness.
import { request as httpRequest } from 'node:http';
import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { HARNESS_SECRETS, signIn } from './sign-in';

const server = createTestHarness({ workers: [{ configPath: './wrangler.jsonc', secrets: HARNESS_SECRETS }] });
const ORIGIN = 'https://resource-webhooks-standalone.transformation.workers.dev';
let base: URL;

beforeAll(async () => {
  base = new URL(String((await server.listen()).url));
});

afterAll(async () => {
  await server.close();
});

function post(path: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(new URL(path, base).href, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (response) => {
      let text = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: text }));
    });
    sent.on('error', reject);
    sent.end(body);
  });
}

it('ignores the whitespace around a mirrored header value, as RFC 9110 does', async () => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
  });
  const token = await signIn(server, ORIGIN);
  const answer = await post('/server/A/mcp', body, {
    Authorization: `Bearer ${token}`,
    'MCP-Protocol-Version': '2026-07-28 ',
    'Mcp-Method': 'tools/list \t',
  });
  expect(answer.status).toBe(200);
  expect(JSON.parse(answer.body)).toMatchObject({ id: 1, result: { resultType: 'complete' } });
});
