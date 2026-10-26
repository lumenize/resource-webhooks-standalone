// Level 2 across a restart, local only. abortAllDurableObjects stands in for a restart of A, since
// evictDurableObject first lets A's retries run to their end, while an abort drops them and keeps
// A's storage. evictDurableObject stands in for B's, whose sockets hibernate across it. These run in
// a file of their own, since evicting B took past the test's 15 s in level2.test.ts after earlier
// tests there had used B, and milliseconds alone, for a reason not yet found.
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { newSecret } from '../../src/standard-webhooks';
import { listen, signedIn, subscribeResource, write } from '../client/parties';
import { newLane } from './lane';
import { receiver } from './receiver';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const delays = env.RETRY_SCHEDULE_MS.split(',').map(Number);
const scheduleMs = delays.reduce((sum, delay) => sum + delay, 0);

async function withNote() {
  const lane = newLane();
  const a = await signedIn(lane, 'a');
  const b = await signedIn(lane, 'b');
  const uri = `${lane.root}/notes/inbox/note-42`;
  return { lane, a, b, uri, v1: await write(a, uri, 'Buy milk') };
}

describe('evictions', () => {
  it('sends no pending version after A restarts, and a refresh then answers the current one', async () => {
    const { b, a, uri } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 503 }) });
    const secret = newSecret();
    await subscribeResource(b, uri, endpoint.url(), secret);
    const v3 = await write(a, uri, 'Three');
    await vi.waitFor(() => expect(endpoint.deliveries().length).toBeGreaterThan(0), { interval: 5 });
    await abortAllDurableObjects();
    const sent = endpoint.deliveries().length;
    await sleep(scheduleMs);
    // The restart cut the retries short, and none followed it.
    expect(sent).toBeLessThan(delays.length + 1);
    expect(endpoint.deliveries()).toHaveLength(sent);
    expect(await subscribeResource(b, uri, endpoint.url(), secret, { version: 'held-before' })).toMatchObject({ version: v3 });
  });

  it("keeps a subscription's id across a lapse, after A's restart has swept the lapsed row", async () => {
    const { lane, b, uri } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const secret = newSecret();
    const first = await subscribeResource(b, uri, endpoint.url(), secret, { ttlMs: 60_000 });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.parse(first.refreshBefore!) + 1000);
      await abortAllDurableObjects();
      const rows = await runInDurableObject(lane.stub, (_instance, state) => state.storage.sql.exec('SELECT COUNT(*) AS count FROM Subscriptions').one().count);
      expect(rows).toBe(0);
      expect((await subscribeResource(b, uri, endpoint.url(), secret)).id).toBe(first.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds the form column to a table of subscriptions made before level 2, when A starts', async () => {
    const { lane, a, b, uri } = await withNote();
    await runInDurableObject(lane.stub, (_instance, state) => {
      state.storage.sql.exec('DROP TABLE Subscriptions');
      state.storage.sql.exec(`CREATE TABLE Subscriptions (
        targetKind TEXT NOT NULL, target TEXT NOT NULL, principal TEXT NOT NULL, url TEXT NOT NULL,
        id TEXT NOT NULL, secret TEXT NOT NULL, expiresAt TEXT NOT NULL,
        PRIMARY KEY (targetKind, target, principal, url)) WITHOUT ROWID`);
    });
    await abortAllDurableObjects();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    await subscribeResource(b, uri, endpoint.url(), newSecret(), { form: 'full' });
    const v2 = await write(a, uri, 'Two');
    await vi.waitFor(() => expect(endpoint.deliveries().map((each) => JSON.parse(each.body))).toEqual([expect.objectContaining({ form: 'full', version: v2 })]));
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
