// Level 1's scenario, run against any tier: the lane's Worker, or a deployed one through the same
// client, as phase 5 asks. It speaks only HTTP and WebSocket, through the parties' module.
import { expect, vi } from 'vitest';
import { SERVER_INFO } from '../../src/server-role/server-role';
import { listen, signedIn, subscribe, watch, write, type Tier } from '../client/parties';

/**
 * Scenario 2: A lists `mcp.resource.updated`, `b` subscribes after SEP-3415's handshake with B, a
 * write by `a` reaches `b` as an occurrence, and the back channel reports it all redacted.
 */
export async function scenario2(tier: Tier): Promise<void> {
  const pageA = await watch(tier, 'A');
  const pageB = await watch(tier, 'B');
  const a = await signedIn(tier, 'a');
  const b = await signedIn(tier, 'b');
  // A note of this run's own, since a deployed A keeps every run's notes.
  const uri = `${tier.root}/notes/inbox/note-${crypto.randomUUID().slice(0, 8)}`;

  expect(await b.client.request('events/list')).toEqual({
    resultType: 'complete',
    events: [
      {
        name: 'mcp.resource.updated',
        description: 'A resource changed',
        delivery: ['webhook'],
        inputSchema: { type: 'object', required: ['uri'], properties: { uri: { type: 'string' } }, additionalProperties: false },
        payloadSchema: { type: 'object', required: ['uri'], properties: { uri: { type: 'string' } } },
      },
    ],
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  });

  const listener = await listen(tier, b);
  const subscribed = await subscribe(b, uri, listener.hookUrl, listener.secret);
  expect(subscribed).toEqual({
    resultType: 'complete',
    id: expect.stringMatching(/^sub_[0-9a-f]{16}$/),
    refreshBefore: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    cursor: null,
    truncated: false,
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  });

  const version = await write(a, uri);
  await vi.waitFor(() => expect(listener.deliveries()).toHaveLength(1));
  const [delivery] = listener.deliveries();
  expect(delivery.subscriptionId).toBe(subscribed.id);
  expect(delivery.webhookId).toMatch(/^msg_[A-Za-z0-9]{24}$/);
  expect(delivery.body).toEqual({
    eventId: `evt_${version}`,
    name: 'mcp.resource.updated',
    timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    data: { uri },
    cursor: null,
  });
  // B answered A's challenge before the occurrence reached it.
  const received = pageB.reports().filter((report) => report.kind === 'delivery' && report.client === b.clientId);
  expect(received.map((report) => [String(report.webhookId).startsWith('msg_verification_'), report.status])).toEqual([
    [true, 200],
    [false, 200],
  ]);
  // b then reads the note, as in Scenario 1a.
  const read = await b.client.request<{ resultType: string; contents: { uri: string; text: string }[] }>('resources/read', { uri });
  expect(read.contents).toEqual([{ uri, mimeType: 'application/json', text: '{"title":"Buy milk","done":false}' }]);

  // A control passes over the same channel, and nothing secret comes back on either.
  expect(await pageA.control('schedule', { delaysMs: [2000, 4000, 8000] })).toEqual({ type: 'done', action: 'schedule' });
  const everything = [...pageA.raw, ...pageB.raw].join('\n');
  expect(everything).toContain('whsec_…(32 bytes)');
  expect(everything).not.toMatch(/whsec_[A-Za-z0-9+/]/);
  expect(everything).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
  expect(everything).not.toContain(tier.operatorToken);
  expect(everything).not.toContain('"control"');
}
