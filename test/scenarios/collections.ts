// Level 2's collection scenarios, 9 and 10, run against any tier: the lane's Worker, or a deployed
// one through the same client. `b` keeps its copies in `Copies`, which holds the inbox's cursor and
// takes a catch-up's pages.
import { expect, vi } from 'vitest';
import { Copies } from '../../src/client/copies';
import type { ResourceChange, ResourceWebhookSubscribeResult } from '../../src/resource-webhooks-types';
import { listen, NETWORK_WAIT, signedIn, socketUrl, subscribeTarget, untilClosed, watch, write, type Listener, type Party, type Tier } from '../client/parties';

export interface InboxRun {
  tier: Tier;
  a: Party;
  b: Party;
  inbox: string;
  copies: Copies;
  results: ResourceWebhookSubscribeResult[];
  /** Every change a delivery brought, in the order they arrived. */
  delivered: ResourceChange[];
  connect(): Promise<Listener>;
}

/** A Wiped A, `a` and `b` signed in, and `b` subscribed to the inbox in the notify form, holding none of it. */
export async function subscribedToInbox(tier: Tier): Promise<InboxRun> {
  const pageA = await watch(tier, 'A');
  const pageB = await watch(tier, 'B');
  expect(await pageA.control('wipe')).toMatchObject({ type: 'done', action: 'wipe' });
  expect(await pageB.control('wipe')).toEqual({ type: 'done', action: 'wipe' });
  pageA.close();
  pageB.close();
  const a = await signedIn(tier, 'a');
  const b = await signedIn(tier, 'b');
  const inbox = `${tier.root}/notes/inbox`;
  const token = await b.session.tokenForResource(tier.origin, socketUrl(tier, b.clientId));
  const results: ResourceWebhookSubscribeResult[] = [];
  const delivered: ResourceChange[] = [];
  let hook: { url: string; secret: string } | undefined;
  const copies = new Copies(async (target, { cursor }) => {
    const result = await subscribeTarget(b, target, hook!.url, hook!.secret, { form: 'notify', ...(cursor ? { cursor } : {}) });
    results.push(result);
    return result;
  });
  const connect = async () => {
    const listener = await listen(tier, b, { token, ...(hook ? { secret: hook.secret } : {}) });
    hook ??= { url: listener.hookUrl, secret: listener.secret };
    listener.onDelivery((body, meta) => {
      delivered.push(body as unknown as ResourceChange);
      copies.deliver(body as unknown as ResourceChange, meta);
    });
    return listener;
  };
  return { tier, a, b, inbox, copies, results, delivered, connect };
}

/**
 * Scenario 9, a folder from nothing and a member delivered, and Scenario 10, a folder caught up
 * by its cursor after an absence, each member once at its newest version.
 */
export async function scenarios9and10(tier: Tier): Promise<void> {
  const run = await subscribedToInbox(tier);
  const { a, inbox, copies, results, delivered } = run;
  let listener = await run.connect();

  // Scenario 9: the inbox is empty, so the result carries no changes and a cursor, not a version.
  await copies.refresh({ uri: inbox });
  expect(results[0]).toEqual({
    resultType: 'complete',
    id: expect.stringMatching(/^sub_[0-9a-f]{16}$/),
    refreshBefore: expect.any(String),
    changes: [],
    cursor: expect.any(String),
    _meta: expect.any(Object),
  });
  const note43 = `${inbox}/note-43`;
  const n43v1 = await write(a, note43, 'Buy milk');
  await vi.waitFor(() => expect(copies.get(note43)).toEqual({ version: n43v1, deleted: false }), NETWORK_WAIT);
  // A new member is a change from nothing, delivered under its own URI, with no cursor (R33).
  expect(delivered).toEqual([{ uri: note43, form: 'notify', version: n43v1 }]);

  // Scenario 10: b sleeps while note-43 is edited twice, note-44 created and note-43 deleted.
  listener.close();
  await untilClosed(tier, run.b.clientId);
  const n43v2 = await write(a, note43, 'Buy oat milk');
  const n43v3 = await write(a, note43, 'Buy oat milk', true);
  const note44 = `${inbox}/note-44`;
  const n44v1 = await write(a, note44, 'Buy bread');
  const deleted = await a.client.request('tools/call', { name: 'delete_note', arguments: { uri: note43 } });
  const n43v4 = (deleted.structuredContent as { version: string }).version;
  listener = await run.connect();
  const before = results.length;
  await copies.refresh({ uri: inbox });
  const caughtUp = results.slice(before).flatMap((result) => result.changes ?? []);
  expect(caughtUp).toHaveLength(2);
  expect(caughtUp).toEqual(
    expect.arrayContaining([
      { uri: note43, form: 'notify', version: n43v4, deleted: true },
      { uri: note44, form: 'notify', version: n44v1 },
    ]),
  );
  // Each member comes back once, at its newest version, so nothing replays the steps between.
  expect(caughtUp.map((change) => change.version)).not.toContain(n43v2);
  expect(caughtUp.map((change) => change.version)).not.toContain(n43v3);
  expect(results.at(-1)!.cursor).not.toBe(results[0].cursor);
  expect(copies.get(note43)).toEqual({ version: n43v4, deleted: true });
  expect(copies.get(note44)).toEqual({ version: n44v1, deleted: false });
  listener.close();
}
