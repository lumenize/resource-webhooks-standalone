// A collection's catch-up a page at a time, in a lane whose page size is one (R35), with b's
// copies taking each page as Copies does.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { Copies } from '../../src/client/copies';
import type { ResourceWebhookSubscribeResult } from '../../src/resource-webhooks-types';
import { newSecret } from '../../src/standard-webhooks';
import { signedIn, subscribeTarget, write } from '../client/parties';
import { newLane } from '../lane/lane';
import { receiver } from '../lane/receiver';

// `pause` runs after each result is taken in, and can hold the next page back.
async function inbox(pause: (index: number) => Promise<void> = async () => {}) {
  const lane = newLane();
  const a = await signedIn(lane, 'a');
  const b = await signedIn(lane, 'b');
  const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
  const secret = newSecret();
  const target = { uri: `${lane.root}/notes/inbox` };
  const results: ResourceWebhookSubscribeResult[] = [];
  const held: string[][] = [];
  const copies: Copies = new Copies(async (subscribed, { cursor }) => {
    const result = await subscribeTarget(b, subscribed, endpoint.url(), secret, cursor ? { cursor } : {});
    results.push(result);
    // What b holds as each page arrives, before Copies takes it.
    held.push(copies.held().sort());
    await pause(results.length - 1);
    return result;
  });
  return { lane, a, b, target, copies, results, held, note: (n: number) => `${target.uri}/note-${n}` };
}

describe('a catch-up in pages of one', () => {
  it('comes in two results for two changes, each member once, the second without hasMore', async () => {
    const { a, b, target, note } = await inbox();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const secret = newSecret();
    const { cursor } = await subscribeTarget(b, target, endpoint.url(), secret);
    const one = await write(a, note(1), 'One');
    const two = await write(a, note(2), 'Two');
    const first = await subscribeTarget(b, target, endpoint.url(), secret, { cursor });
    expect(first).toMatchObject({ changes: [{ uri: note(1), version: one }], hasMore: true });
    const second = await subscribeTarget(b, target, endpoint.url(), secret, { cursor: first.cursor });
    expect(second.changes).toEqual([{ uri: note(2), form: 'notify', version: two }]);
    expect(second).not.toHaveProperty('hasMore');
  });

  it("returns a write made between a listing's pages in the next refresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { a, target, copies, results, note } = await inbox((index) => (index === 0 ? gate : Promise.resolve()));
    await write(a, note(1), 'One');
    await write(a, note(2), 'Two');
    const pages = copies.refresh(target);
    await vi.waitFor(() => expect(results).toHaveLength(1));
    const between = await write(a, note(1), 'One, edited between the pages');
    release();
    await pages;
    expect(results.map((result) => result.changes!.map((change) => change.uri))).toEqual([[note(1)], [note(2)]]);
    await copies.refresh(target);
    expect(copies.get(note(1))?.version).toBe(between);
  });

  it("drops nothing during a paged reset until its last page", async () => {
    const { a, target, copies, results, held, note } = await inbox();
    for (const n of [1, 2, 3]) await write(a, note(n), `Note ${n}`);
    await copies.refresh(target);
    expect(copies.held().sort()).toEqual([note(1), note(2), note(3)]);
    await a.client.request('tools/call', { name: 'delete_note', arguments: { uri: note(3) } });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + Number(env.CUTOFF_WINDOW_MS) + 1000);
      await write(a, `${target.uri.replace('/inbox', '/archive')}/note-9`, 'Prunes the deletion');
      const before = results.length;
      await copies.refresh(target);
      const reset = results.slice(before);
      expect(reset.map((result) => [result.reset, result.hasMore ?? false])).toEqual([
        [true, true],
        [true, false],
      ]);
      // As the reset's second page arrived, b still held the member only its last page could drop.
      expect(held[before + 1]).toEqual([note(1), note(2), note(3)]);
      expect(copies.held().sort()).toEqual([note(1), note(2)]);
    } finally {
      vi.useRealTimers();
    }
  });
});
