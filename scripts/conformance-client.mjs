#!/usr/bin/env node
// The command the conformance suite's client scenarios drive: it runs `src/client/mcp-client.ts`
// against the server URL the suite appends, signing in when the server asks, listing tools, and
// calling one, `add_numbers` where the scenario offers it. Node strips the module's types itself.
import { createMcpClient, OAuthSession } from '../src/client/mcp-client.ts';

const serverUrl = process.argv.at(-1);
const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? '';
const context = JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT ?? '{}');

const client = createMcpClient({
  endpoint: serverUrl,
  clientInfo: { name: 'resource-webhooks-conformance-client', version: '0.0.0' },
  oauth: new OAuthSession({
    redirectUri: 'http://localhost:3000/callback',
    clientName: 'resource-webhooks-conformance-client',
    ...(context.client_id ? { client: { clientId: context.client_id, clientSecret: context.client_secret } } : {}),
  }),
});

try {
  const { tools = [] } = await client.request('tools/list');
  const add = tools.find((tool) => tool.name === 'add_numbers');
  const tool = add ?? tools[0];
  if (tool) await client.request('tools/call', { name: tool.name, arguments: add ? { a: 1, b: 2 } : {} });
  // A second request reuses the token, as a session that goes on would.
  await client.request('tools/list');
  console.log(`${scenario}: listed ${tools.length} tool(s)`);
} catch (error) {
  console.error(`${scenario}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
