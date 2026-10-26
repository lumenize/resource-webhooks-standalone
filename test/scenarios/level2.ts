// Level 2's scenarios, 3 to 8, as one narrative on one note, run against any tier: the lane's
// Worker, or a deployed one through the same client. `b` keeps its copy in `Copies`, the client
// module that takes deliveries and refresh results as R15 and R41 ask.
import { expect, vi } from 'vitest';
import { Copies } from '../../src/client/copies';
import type { ResourceChange } from '../../src/resource-webhooks-types';
import { SERVER_INFO } from '../../src/server-role/server-role';
import { listen, NETWORK_WAIT, signedIn, socketUrl, subscribeResource, untilClosed, watch, write, type Listener, type Page, type Tier } from '../client/parties';

const META = { 'io.modelcontextprotocol/serverInfo': SERVER_INFO };

/** A's reports of its delivery attempts to one URL, as `[attempt, outcome]`. */
function attemptsTo(page: Page, url: string): [number, string][] {
  return page
    .reports()
    .filter((report) => report.kind === 'attempt' && report.url === url)
    .map((report) => [report.attempt as number, report.outcome as string]);
}

/**
 * Scenarios 3 to 8: `b` subscribes from nothing, hears a change, refreshes, misses two edits and
 * gets only the newer, misses one past the retries and catches up by refreshing, and hears a
 * deletion, after which the subscription carries on.
 */
export async function level2(tier: Tier): Promise<void> {
  const pageA = await watch(tier, 'A');
  const pageB = await watch(tier, 'B');
  expect(await pageA.control('wipe')).toMatchObject({ type: 'done', action: 'wipe' });
  expect(await pageB.control('wipe')).toEqual({ type: 'done', action: 'wipe' });
  const a = await signedIn(tier, 'a');
  const b = await signedIn(tier, 'b');
  const uri = `${tier.root}/notes/inbox/note-${crypto.randomUUID().slice(0, 8)}`;
  const note = (title: string, done: boolean) => [{ uri, mimeType: 'application/json', text: JSON.stringify({ title, done }) }];
  const changes: ResourceChange[] = [];
  let listener: Listener | undefined;
  // b's own token for its socket, got once, so a reconnect is quick.
  const socketToken = await b.session.tokenForResource(tier.origin, socketUrl(tier, b.clientId));
  const connect = async (secret?: string) => {
    listener = await listen(tier, b, { token: socketToken, ...(secret ? { secret } : {}) });
    listener.onDelivery((body, meta) => {
      changes.push(body as unknown as ResourceChange);
      copies.deliver(body as unknown as ResourceChange, meta);
    });
    return listener;
  };

  const refreshed = async (target: string) => {
    await copies.refresh({ uri: target });
    return copies.get(target);
  };

  // Scenario 3: a first subscription, from nothing, in the full form, with the contents in the result.
  const v1 = await write(a, uri, 'Buy milk');
  const first = await connect();
  const { hookUrl, secret } = first;
  const results: Record<string, unknown>[] = [];
  const copies = new Copies(async (target, { version }) => {
    const result = await subscribeResource(b, (target as { uri: string }).uri, hookUrl, secret, { form: 'full', catchUp: 'full', ...(version ? { version } : {}) });
    results.push(result);
    return result;
  });
  expect(await refreshed(uri)).toEqual({ version: v1, deleted: false, contents: note('Buy milk', false) });
  const [subscribed] = results;
  expect(subscribed).toEqual({
    resultType: 'complete',
    id: expect.stringMatching(/^sub_[0-9a-f]{16}$/),
    refreshBefore: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    version: v1,
    contents: note('Buy milk', false),
    _meta: META,
  });

  // Scenario 4: a change it hears about, in the full form, which B passes on as it was.
  const v2 = await write(a, uri, 'Buy milk', true);
  await vi.waitFor(() => expect(copies.get(uri)?.version).toBe(v2), NETWORK_WAIT);
  expect(first.deliveries().map(({ subscriptionId, webhookId, body }) => ({ subscriptionId, webhookId, body }))).toEqual([
    { subscriptionId: subscribed.id, webhookId: expect.stringMatching(/^msg_[A-Za-z0-9]{24}$/), body: { uri, form: 'full', version: v2, contents: note('Buy milk', true) } },
  ]);

  // Scenario 5: a refresh naming the version held answers it, with no contents and a new grant.
  const before = results.length;
  expect(await refreshed(uri)).toEqual({ version: v2, deleted: false, contents: note('Buy milk', true) });
  expect(results[before]).toEqual({ resultType: 'complete', id: subscribed.id, refreshBefore: expect.any(String), version: v2, _meta: META });
  expect(Date.parse(results[before].refreshBefore as string)).toBeGreaterThanOrEqual(Date.parse(subscribed.refreshBefore as string));

  // Scenario 6: two edits while b is away, and only the newer reaches it. A retries on the demo's
  // schedule for it, so b is back before a retry, however slowly a loaded machine reconnects it.
  const DEMO_SCHEDULE = [2000, 4000, 8000];
  expect(await pageA.control('schedule', { delaysMs: DEMO_SCHEDULE })).toMatchObject({ type: 'done' });
  first.close();
  await untilClosed(tier, b.clientId);
  const v3 = await write(a, uri, 'Buy oat milk');
  await vi.waitFor(() => expect(attemptsTo(pageA, hookUrl).length).toBeGreaterThan(0), NETWORK_WAIT);
  const v4 = await write(a, uri, 'Buy oat milk', true);
  const second = await connect(secret);
  await vi.waitFor(() => expect(copies.get(uri)?.version).toBe(v4), { ...NETWORK_WAIT, timeout: NETWORK_WAIT.timeout + DEMO_SCHEDULE[0] });
  expect(second.deliveries().map(({ body }) => body)).toEqual([{ uri, form: 'full', version: v4, contents: note('Buy oat milk', true) }]);
  expect(changes.map((change) => change.version)).not.toContain(v3);
  expect(await pageA.control('schedule', { delaysMs: null })).toMatchObject({ type: 'done' });

  // Scenario 7: an absence longer than the retries, made up by a refresh naming the version held.
  second.close();
  await untilClosed(tier, b.clientId);
  const attempted = attemptsTo(pageA, hookUrl).length;
  const v5 = await write(a, uri, 'Buy oat milk and bread', true);
  const window = tier.retryScheduleMs.reduce((sum, delay) => sum + delay, 0);
  await vi.waitFor(() => expect(attemptsTo(pageA, hookUrl).slice(attempted)).toHaveLength(tier.retryScheduleMs.length + 1), { ...NETWORK_WAIT, timeout: NETWORK_WAIT.timeout + window });
  expect(copies.get(uri)?.version).toBe(v4);
  await connect(secret);
  expect(await refreshed(uri)).toEqual({ version: v5, deleted: false, contents: note('Buy oat milk and bread', true) });

  // Scenario 8: a deletion goes in the notify form, and the subscription carries on.
  const deleted = await a.client.request('tools/call', { name: 'delete_note', arguments: { uri } });
  const v6 = (deleted.structuredContent as { version: string }).version;
  await vi.waitFor(() => expect(copies.get(uri)).toEqual({ version: v6, deleted: true }), NETWORK_WAIT);
  expect(changes.at(-1)).toEqual({ uri, form: 'notify', version: v6, deleted: true });
  expect(await refreshed(uri)).toEqual({ version: v6, deleted: true });
  const v7 = await write(a, uri, 'Buy milk again');
  await vi.waitFor(() => expect(copies.get(uri)).toEqual({ version: v7, deleted: false, contents: note('Buy milk again', false) }), NETWORK_WAIT);
  expect(new Set([v1, v2, v3, v4, v5, v6, v7]).size).toBe(7);

  listener?.close();
  pageA.close();
  pageB.close();
}
