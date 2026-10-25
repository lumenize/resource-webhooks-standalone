#!/usr/bin/env node
// The command the conformance suite's client scenarios drive: it runs `src/client/mcp-client.ts`
// against the server URL the suite appends, signing in when the server asks, listing tools, and
// calling one, `add_numbers` where the scenario offers it. An Events scenario instead subscribes
// as level 1's `b` does. Node strips the modules' types itself.
import { createMcpClient, OAuthSession } from '../src/client/mcp-client.ts';
import { newSecret } from '../src/standard-webhooks.ts';

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

// Subscribes to every type the server delivers by webhook, and refreshes each halfway through its
// grant, with the same key and the cursor the server last returned, until the scenario's time is
// up. The suite never POSTs to the callback, so its URL is one nothing answers.
async function events() {
  const { capabilities } = await client.request('server/discover');
  if (!capabilities?.extensions?.['io.modelcontextprotocol/events']) return 'the server declares no Events';
  const { events: types = [] } = await client.request('events/list');
  const secret = newSecret();
  const subscriptions = types.filter((type) => type.delivery?.includes('webhook')).map((type) => ({ name: type.name, cursor: null, refreshAt: 0 }));
  const until = Date.now() + (context.durationMs ?? 5000);
  while (Date.now() < until) {
    for (const subscription of subscriptions) {
      if (Date.now() < subscription.refreshAt) continue;
      const grantedAt = Date.now();
      const result = await client.request('events/subscribe', {
        name: subscription.name,
        arguments: {},
        delivery: { mode: 'webhook', url: 'https://receiver.invalid/hooks/conformance', secret },
        cursor: subscription.cursor,
      });
      subscription.cursor = result.cursor ?? null;
      subscription.refreshAt = grantedAt + (Date.parse(result.refreshBefore) - grantedAt) / 2;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return `kept ${subscriptions.length} webhook subscription(s)`;
}

try {
  if (scenario.startsWith('events-client-')) {
    console.log(`${scenario}: ${await events()}`);
    process.exit(0);
  }
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
