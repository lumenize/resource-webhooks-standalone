// Level 2 across a restart, local only: evictDurableObject stands in for one. These run in a file
// of their own, so B is fresh. After some earlier tests in level2.test.ts had used B, evicting it
// took past the test's 15 s there, and in milliseconds alone, for a reason not yet found.
import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { newSecret } from '../../src/standard-webhooks';
import { listen, signedIn, subscribeResource, write } from '../client/parties';
import { newLane } from './lane';
import { receiver } from './receiver';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const scheduleMs = env.RETRY_SCHEDULE_MS.split(',').map(Number).reduce((sum, delay) => sum + delay, 0);

async function withNote() {
  const lane = newLane();
  const a = await signedIn(lane, 'a');
  const b = await signedIn(lane, 'b');
  const uri = `${lane.root}/notes/inbox/note-42`;
  return { lane, a, b, uri, v1: await write(a, uri, 'Buy milk') };
}

describe('evictions', () => {
  it('sends no pending version after A is evicted, and a refresh then answers the current one', async () => {
    const { lane, a, b, uri } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 503 }) });
    const secret = newSecret();
    await subscribeResource(b, uri, endpoint.url(), secret);
    const v3 = await write(a, uri, 'Three');
    await vi.waitFor(() => expect(endpoint.deliveries().length).toBeGreaterThan(0));
    await evictDurableObject(lane.stub);
    const sent = endpoint.deliveries().length;
    await sleep(scheduleMs);
    expect(endpoint.deliveries()).toHaveLength(sent);
    expect(await subscribeResource(b, uri, endpoint.url(), secret, { version: 'held-before' })).toMatchObject({ version: v3 });
  });

  it("verifies a delivery against the socket's attachment after B is evicted with its sockets hibernated", async () => {
    const { lane, a, b, uri } = await withNote();
    const listener = await listen(lane, b);
    await subscribeResource(b, uri, listener.hookUrl, listener.secret);
    await evictDurableObject(env.GATEWAY.getByName(lane.gateway));
    const v2 = await write(a, uri, 'After the eviction');
    await vi.waitFor(() => expect(listener.deliveries().map((delivery) => delivery.body.version)).toEqual([v2]));
    expect(listener.closes).toEqual([]);
  });
});
