// Level 2 for one resource: this extension's own methods, the ResourceChange each write delivers,
// and the queue that coalesces them. Real timers, as in level 1's tests, and a clock that moves
// where a grant must run out.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { Copies } from '../../src/client/copies';
import { createMcpClient, ExtensionNotDeclaredError, McpError } from '../../src/client/mcp-client';
import type { ResourceChange } from '../../src/resource-webhooks-types';
import { FULL_BODY_LIMIT } from '../../src/server-role/resource-webhooks';
import { subscriptionId } from '../../src/server-role/subscriptions';
import { newSecret } from '../../src/standard-webhooks';
import { listen, signedIn, subscribeResource, untilClosed, versioned, watch, write, type Party } from '../client/parties';
import { level2 } from '../scenarios/level2';
import { newLane, type Lane } from './lane';
import { echo, receiver, type Received } from './receiver';

describe('Scenarios 3 to 8: one note through level 2', () => {
  it('subscribes from nothing, hears changes, refreshes, coalesces, catches up and hears a deletion', () => level2(newLane()));
});

// The criteria beyond the scenarios, each against a fake receiver or B, in the lane.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const delays = env.RETRY_SCHEDULE_MS.split(',').map(Number);
const scheduleMs = delays.reduce((sum, delay) => sum + delay, 0);
const body = (received: Received) => JSON.parse(received.body) as ResourceChange;
const versions = (received: Received[]) => received.map((each) => body(each).version);

async function refusal(promise: Promise<unknown>): Promise<{ code: number; data?: unknown }> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(McpError);
  return { code: (error as McpError).code, data: (error as McpError).data };
}

/** A lane with `a` and `b` signed in and a note `a` has written once. */
async function withNote(): Promise<{ lane: Lane; a: Party; b: Party; uri: string; v1: string }> {
  const lane = newLane();
  const a = await signedIn(lane, 'a');
  const b = await signedIn(lane, 'b');
  const uri = `${lane.root}/notes/inbox/note-42`;
  return { lane, a, b, uri, v1: await write(a, uri, 'Buy milk') };
}

describe("A's subscribe", () => {
  it('reads the version only once its handshake succeeds, so a write during the handshake is in the result', async () => {
    const { a, b, uri } = await withNote();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const endpoint = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: async (received, index) => {
        await gate;
        return echo(received, index);
      },
    });
    const pending = subscribeResource(b, uri, endpoint.url(), newSecret(), { catchUp: 'full' });
    await vi.waitFor(() => expect(endpoint.challenges()).toHaveLength(1));
    const v2 = await write(a, uri, 'Buy milk', true);
    release();
    expect(await pending).toMatchObject({ version: v2, contents: [{ uri, mimeType: 'application/json', text: '{"title":"Buy milk","done":true}' }] });
  });

  it("answers a URI nobody wrote with A's base version, deleted, and delivers the first write as its first version", async () => {
    const lane = newLane();
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/inbox/note-new`;
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const result = await subscribeResource(b, uri, endpoint.url(), newSecret(), { catchUp: 'full' });
    expect(result).toMatchObject({ version: expect.stringMatching(/^e\d+\.b\d+$/), deleted: true });
    expect(result).not.toHaveProperty('contents');
    const v1 = await write(a, uri, 'First');
    await vi.waitFor(() => expect(versions(endpoint.deliveries())).toEqual([v1]));
    expect(v1).not.toBe(result.version);
  });

  it("names the version the note's ETag carries, without its quotes", async () => {
    const { lane, b, uri, v1 } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const { version } = await subscribeResource(b, uri, endpoint.url(), newSecret());
    const read = await lane.fetch('/notes/inbox/note-42');
    expect(read.headers.get('ETag')).toBe(`"${version}"`);
    expect(version).toBe(v1);
  });

  it('carries no contents in a refresh asking for notify, though the subscription is full', async () => {
    const { b, uri, v1 } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const secret = newSecret();
    expect(await subscribeResource(b, uri, endpoint.url(), secret, { form: 'full', catchUp: 'full' })).toHaveProperty('contents');
    const refreshed = await subscribeResource(b, uri, endpoint.url(), secret, { form: 'full', catchUp: 'notify' });
    expect(refreshed).toMatchObject({ version: v1 });
    expect(refreshed).not.toHaveProperty('contents');
  });

  it('refuses a URI A could never serve, a second target and a plain-http URL with InvalidParams', async () => {
    const { lane, b, uri } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    expect(await refusal(subscribeResource(b, `${lane.root}/nowhere/note-1`, endpoint.url(), newSecret()))).toEqual({ code: -32602, data: { uri: `${lane.root}/nowhere/note-1` } });
    expect(await refusal(subscribeResource(b, 'https://elsewhere.example/notes/note-1', endpoint.url(), newSecret()))).toMatchObject({ code: -32602 });
    expect(await refusal(subscribeResource(b, uri, endpoint.url(), newSecret(), { listed: true }))).toMatchObject({ code: -32602 });
    expect(await refusal(b.client.request('resources/webhooks/unsubscribe', { uri, delivery: { url: endpoint.url().replace('https:', 'http:') } }))).toMatchObject({ code: -32602 });

    expect(endpoint.challenges()).toHaveLength(0);
  });

  it('refuses a missing or mismatched Mcp-Name with HeaderMismatch, and a header on a listed target', async () => {
    const { lane, uri } = await withNote();
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    const delivery = { url: 'https://receiver.invalid/hook', secret: newSecret() };
    const cases: [string, Record<string, unknown>, string | undefined][] = [
      ['resources/webhooks/subscribe', { uri, delivery }, undefined],
      ['resources/webhooks/subscribe', { uri, delivery }, `${uri}-other`],
      ['resources/webhooks/unsubscribe', { uri, delivery: { url: delivery.url } }, undefined],
      ['resources/webhooks/subscribe', { listed: true, delivery }, uri],
    ];
    for (const [method, params, name] of cases) {
      const response = await lane.fetch('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await lane.token()}`,
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': method,
          ...(name === undefined ? {} : { 'Mcp-Name': name }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
      });
      const label = { method, name, listed: 'listed' in params };
      expect({ ...label, status: response.status, code: ((await response.json()) as { error: { code: number } }).error.code }).toEqual({ ...label, status: 400, code: -32020 });
    }
  });

  it('counts no lapsed subscription toward the cap, and answers NotFound to unsubscribing one', async () => {
    const { lane, b } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const cap = Number(env.SUBSCRIPTION_CAP);
    const note = (n: number) => `${lane.root}/notes/inbox/note-${n}`;
    for (let n = 0; n < cap; n++) await subscribeResource(b, note(n), endpoint.url(), newSecret(), { ttlMs: 60_000 });
    expect(await refusal(subscribeResource(b, note(cap), endpoint.url(), newSecret()))).toMatchObject({ code: -32025 });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect((await subscribeResource(b, note(cap), endpoint.url(), newSecret())).resultType).toBe('complete');
      expect(await refusal(b.client.request('resources/webhooks/unsubscribe', { uri: note(0), delivery: { url: endpoint.url() } }))).toEqual({ code: -32023, data: { kind: 'subscription' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives the id from the key with the binding's hash key, and keeps it across a refresh and a lapse", async () => {
    const { b, uri } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const secret = newSecret();
    const first = await subscribeResource(b, uri, endpoint.url(), secret, { ttlMs: 60_000 });
    expect(first.id).toBe(await subscriptionId(env.SUBSCRIPTION_ID_KEY, [b.clientId, endpoint.url(), 'uri', uri]));
    expect((await subscribeResource(b, uri, endpoint.url(), secret)).id).toBe(first.id);
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.parse(first.refreshBefore!) + 3_700_000);
      expect((await subscribeResource(b, uri, endpoint.url(), secret)).id).toBe(first.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops delivering past refreshBefore, and a new subscribe naming the version held answers the current one', async () => {
    const { a, b, uri, v1 } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const secret = newSecret();
    const { refreshBefore } = await subscribeResource(b, uri, endpoint.url(), secret, { ttlMs: 60_000 });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.parse(refreshBefore!) + 1000);
      const v2 = await write(a, uri, 'Unheard');
      await sleep(scheduleMs);
      expect(endpoint.deliveries()).toEqual([]);
      expect(await subscribeResource(b, uri, endpoint.url(), secret, { version: v1, catchUp: 'full' })).toMatchObject({ version: v2, contents: [{ text: '{"title":"Unheard","done":false}' }] });
      const v3 = await write(a, uri, 'Heard');
      await vi.waitFor(() => expect(versions(endpoint.deliveries())).toEqual([v3]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a subscription past the cap per principal, across both levels, with ResourceExhausted', async () => {
    const { lane, b, uri } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const cap = Number(env.SUBSCRIPTION_CAP);
    await b.client.request('events/subscribe', { name: 'mcp.resource.updated', arguments: { uri }, delivery: { mode: 'webhook', url: endpoint.url(), secret: newSecret() }, cursor: null });
    for (let n = 1; n < cap; n++) await subscribeResource(b, `${lane.root}/notes/inbox/note-${n}`, endpoint.url(), newSecret());
    expect(await refusal(subscribeResource(b, `${lane.root}/notes/inbox/note-${cap}`, endpoint.url(), newSecret()))).toEqual({ code: -32025, data: { limit: 'subscriptions', max: cap } });
  });

  it("answers NotFound to another principal's unsubscribe with the same target and URL, and the subscription still delivers", async () => {
    const { lane, a, b, uri } = await withNote();
    const c = await signedIn(lane, 'c');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    await subscribeResource(b, uri, endpoint.url(), newSecret());
    const key = { uri, delivery: { url: endpoint.url() } };
    expect(await refusal(c.client.request('resources/webhooks/unsubscribe', key))).toEqual({ code: -32023, data: { kind: 'subscription' } });
    const v2 = await write(a, uri, 'Still heard');
    await vi.waitFor(() => expect(versions(endpoint.deliveries())).toEqual([v2]));
    expect(await b.client.request('resources/webhooks/unsubscribe', key)).toMatchObject({ resultType: 'complete' });
    await write(a, uri, 'Unheard');
    await sleep(scheduleMs);
    expect(versions(endpoint.deliveries())).toEqual([v2]);
  });

  it('replaces the form and the secret on a refresh, with b registering the new secret at B first', async () => {
    const { lane, a, b, uri } = await withNote();
    const listener = await listen(lane, b);
    await subscribeResource(b, uri, listener.hookUrl, listener.secret);
    const v2 = await write(a, uri, 'Notify');
    await vi.waitFor(() => expect(listener.deliveries().map(({ body }) => body)).toEqual([{ uri, form: 'notify', version: v2 }]));
    const rotated = newSecret();
    await listener.register(rotated);
    await subscribeResource(b, uri, listener.hookUrl, rotated, { form: 'full' });
    const v3 = await write(a, uri, 'Full');
    await vi.waitFor(() => expect(listener.deliveries().at(-1)?.body).toEqual({ uri, form: 'full', version: v3, contents: [{ uri, mimeType: 'application/json', text: '{"title":"Full","done":false}', ...versioned(v3) }] }));
  });
});

describe('the base version', () => {
  it('moves past a deletion once the deletion is pruned, so no URI is given a version it had', async () => {
    const lane = newLane();
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const uri = `${lane.root}/notes/inbox/note-short-lived`;
    const subscribe = () => subscribeResource(b, uri, endpoint.url(), newSecret());
    const { version: before } = await subscribe();
    await write(a, uri, 'Short-lived');
    const deleted = await a.client.request('tools/call', { name: 'delete_note', arguments: { uri } });
    const deletion = (deleted.structuredContent as { version: string }).version;
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      // A write anywhere prunes a deletion older than the cut-off window.
      vi.setSystemTime(Date.now() + Number(env.CUTOFF_WINDOW_MS) + 1000);
      await write(a, `${lane.root}/notes/inbox/note-other`, 'Prunes');
      const { version: after, deleted: still } = await subscribe();
      expect(still).toBe(true);
      expect([before, deletion]).not.toContain(after);
      expect(after).toMatch(/^e\d+\.b\d+$/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("A's deliveries of a ResourceChange", () => {
  it("makes no attempt once the subscription's grant lapses", async () => {
    const { a, b, uri } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 503 }) });
    const { refreshBefore } = await subscribeResource(b, uri, endpoint.url(), newSecret(), { ttlMs: 60_000 });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      await write(a, uri, 'Retried until the grant lapses');
      await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
      vi.setSystemTime(Date.parse(refreshBefore!) + 1000);
      await sleep(scheduleMs);
      expect(endpoint.deliveries()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a new subscription\'s delivery until a POST out at the unsubscribe is answered', async () => {
    const { a, b, uri } = await withNote();
    let answer!: () => void;
    const held = new Promise<void>((resolve) => (answer = resolve));
    const endpoint = receiver({
      deliveries: async (_received, index) => {
        if (index === 0) await held;
        return new Response(null, { status: 200 });
      },
    });
    const secret = newSecret();
    await subscribeResource(b, uri, endpoint.url(), secret);
    const v2 = await write(a, uri, 'Out at the unsubscribe');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    await b.client.request('resources/webhooks/unsubscribe', { uri, delivery: { url: endpoint.url() } });
    await subscribeResource(b, uri, endpoint.url(), secret);
    const v3 = await write(a, uri, 'After it');
    await sleep(100);
    expect(versions(endpoint.deliveries())).toEqual([v2]);
    answer();
    await vi.waitFor(() => expect(versions(endpoint.deliveries())).toEqual([v2, v3]));
  });

  it('delivers only the newer of two versions while the receiver answers 503, and never the older after it', async () => {
    const { a, b, uri } = await withNote();
    let accepting = false;
    const endpoint = receiver({ deliveries: () => new Response(null, { status: accepting ? 200 : 503 }) });
    await subscribeResource(b, uri, endpoint.url(), newSecret());
    const v3 = await write(a, uri, 'Three');
    await vi.waitFor(() => expect(endpoint.deliveries().length).toBeGreaterThan(0), { interval: 5 });
    const v4 = await write(a, uri, 'Four');
    accepting = true;
    await vi.waitFor(() => expect(versions(endpoint.deliveries()).at(-1)).toBe(v4));
    await sleep(scheduleMs);
    // v4 may be refused once too, before the receiver accepts, but nothing but v4 follows it.
    const sent = versions(endpoint.deliveries());
    expect(sent.slice(sent.indexOf(v4)).every((version) => version === v4)).toBe(true);
    expect(sent.filter((version) => version === v3)).toHaveLength(1);
  });

  it("sends a newer version once the receiver's 200 for the older arrives", async () => {
    const { a, b, uri } = await withNote();
    let answer!: () => void;
    const held = new Promise<void>((resolve) => (answer = resolve));
    const endpoint = receiver({
      deliveries: async (_received, index) => {
        if (index === 0) await held;
        return new Response(null, { status: 200 });
      },
    });
    await subscribeResource(b, uri, endpoint.url(), newSecret());
    const v3 = await write(a, uri, 'Three');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    const v4 = await write(a, uri, 'Four');
    await sleep(50);
    expect(versions(endpoint.deliveries())).toEqual([v3]);
    answer();
    await vi.waitFor(() => expect(versions(endpoint.deliveries())).toEqual([v3, v4]));
  });

  it('keeps one webhook-id across the retries of a version, and mints a new one for the version that replaces it', async () => {
    const { a, b, uri } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 503 }) });
    await subscribeResource(b, uri, endpoint.url(), newSecret());
    const v3 = await write(a, uri, 'Three');
    await vi.waitFor(() => expect(endpoint.deliveries().length).toBeGreaterThanOrEqual(2));
    const v4 = await write(a, uri, 'Four');
    await vi.waitFor(() => expect(versions(endpoint.deliveries())).toContain(v4));
    const idsOf = (version: string) => new Set(endpoint.deliveries().filter((each) => body(each).version === version).map((each) => each.headers.get('webhook-id')));
    expect(idsOf(v3).size).toBe(1);
    expect(idsOf(v4).size).toBe(1);
    expect([...idsOf(v3)][0]).not.toBe([...idsOf(v4)][0]);
  });

  it("stops a version on the receiver's 410, and delivers the next", async () => {
    const { a, b, uri } = await withNote();
    const endpoint = receiver({ deliveries: (_received, index) => new Response(null, { status: index === 0 ? 410 : 200 }) });
    await subscribeResource(b, uri, endpoint.url(), newSecret());
    const v2 = await write(a, uri, 'Gone');
    await sleep(scheduleMs);
    expect(versions(endpoint.deliveries())).toEqual([v2]);
    const v3 = await write(a, uri, 'Next');
    await vi.waitFor(() => expect(versions(endpoint.deliveries())).toEqual([v2, v3]));
  });

  it('delivers a change whose full body would pass 256 KiB in the notify form', async () => {
    const { a, b, uri } = await withNote();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    await subscribeResource(b, uri, endpoint.url(), newSecret(), { form: 'full' });
    const big = await write(a, uri, 'x'.repeat(FULL_BODY_LIMIT));
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    expect(body(endpoint.deliveries()[0])).toEqual({ uri, form: 'notify', version: big });
    const small = await write(a, uri, 'small');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(2));
    expect(body(endpoint.deliveries()[1])).toMatchObject({ form: 'full', version: small });
  });

  it("delivers to b at once while c's retries run, sends nothing for c down b's socket, and gives each its own webhook-id", async () => {
    const { lane, a, b, uri } = await withNote();
    const c = await signedIn(lane, 'c');
    const page = await watch(lane, 'A');
    const forB = await listen(lane, b);
    const forC = await listen(lane, c);
    await subscribeResource(b, uri, forB.hookUrl, forB.secret);
    await subscribeResource(c, uri, forC.hookUrl, forC.secret);
    forC.close();
    await untilClosed(lane, c.clientId);
    const v2 = await write(a, uri, 'Two');
    await vi.waitFor(() => expect(forB.deliveries().map(({ body }) => body.version)).toEqual([v2]));
    const attempts = page.reports().filter((report) => report.kind === 'attempt');
    const toC = attempts.filter((report) => report.url === forC.hookUrl);
    expect(toC.map((report) => report.outcome)).toContain('503');
    expect(forB.deliveries()).toHaveLength(1);
    const webhookIdFor = (url: string) => attempts.find((report) => report.url === url)?.webhookId;
    expect(webhookIdFor(forB.hookUrl)).not.toBe(webhookIdFor(forC.hookUrl));
    // c's v2 is retried, and a second version, while c's retries still run, reaches b too. A queue
    // shared by the two subscriptions would let one's newer message replace the other's, and
    // drop c's retries or b's v3, depending on which subscription A delivers to first.
    const toCForV2 = () => page.reports().filter((report) => report.kind === 'attempt' && report.webhookId === webhookIdFor(forC.hookUrl));
    await vi.waitFor(() => expect(toCForV2().length).toBeGreaterThanOrEqual(2));
    const v3 = await write(a, uri, 'Three');
    await vi.waitFor(() => expect(forB.deliveries().map(({ body }) => body.version)).toEqual([v2, v3]));
  });
});

describe("b's copies", () => {
  it('refreshes again when a delivery crosses a refresh, and ends at the newer version', async () => {
    const { lane, a, b, uri } = await withNote();
    const listener = await listen(lane, b);
    let hold: Promise<void> | undefined;
    const results: string[] = [];
    const copies = new Copies(async (target, { version }) => {
      const result = await subscribeResource(b, (target as { uri: string }).uri, listener.hookUrl, listener.secret, { catchUp: 'full', ...(version ? { version } : {}) });
      results.push(result.version!);
      await hold;
      return result;
    });
    listener.onDelivery((change, meta) => copies.deliver(change as unknown as ResourceChange, meta));
    const v4 = await write(a, uri, 'Four');
    await copies.refresh({ uri });
    expect(copies.get(uri)?.version).toBe(v4);

    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    const refreshing = copies.refresh({ uri });
    await vi.waitFor(() => expect(results).toHaveLength(2));
    const v5 = await write(a, uri, 'Five');
    await vi.waitFor(() => expect(copies.get(uri)?.version).toBe(v5));
    hold = undefined;
    release();
    await refreshing;
    // The crossed result named v4, so it was not taken, and the refresh made again named v5.
    expect(results.slice(1)).toEqual([v4, v5]);
    expect(copies.get(uri)).toEqual({ version: v5, deleted: false });
  });

  it('runs a second refresh of one resource after the first, and a delivery that crosses the second is not lost', async () => {
    const { lane, a, b, uri } = await withNote();
    const listener = await listen(lane, b);
    const gates: (() => void)[] = [];
    let held = false;
    const results: string[] = [];
    const copies = new Copies(async (target, { version }) => {
      const result = await subscribeResource(b, (target as { uri: string }).uri, listener.hookUrl, listener.secret, { ...(version ? { version } : {}) });
      results.push(result.version!);
      if (held) await new Promise<void>((resolve) => gates.push(resolve));
      return result;
    });
    listener.onDelivery((change, meta) => copies.deliver(change as unknown as ResourceChange, meta));
    await copies.refresh({ uri });
    const v1 = copies.get(uri)!.version;
    held = true;
    const first = copies.refresh({ uri });
    const second = copies.refresh({ uri });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    // The second waits for the first, so only one request is out.
    expect(results).toEqual([v1, v1]);
    gates[0]();
    await first;
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    held = false;
    const v2 = await write(a, uri, 'Two');
    await vi.waitFor(() => expect(copies.get(uri)?.version).toBe(v2));
    gates[1]();
    await second;
    expect(results).toEqual([v1, v1, v1, v2]);
    expect(copies.get(uri)?.version).toBe(v2);
  });
});

describe('the client', () => {
  it("calls none of the extension's methods on a server that has not declared it", async () => {
    const sent: string[] = [];
    const fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      const { method } = JSON.parse(init.body as string) as { method: string };
      sent.push(method);
      const capabilities = { tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/events': {} } };
      return Response.json({ jsonrpc: '2.0', id: 1, result: method === 'server/discover' ? { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities } : { resultType: 'complete' } });
    }) as typeof globalThis.fetch;
    const client = createMcpClient({ endpoint: 'https://server.example/mcp', fetch });
    const params = { uri: 'https://server.example/notes/note-1', delivery: { url: 'https://receiver.example/hook', secret: newSecret() } };
    await expect(client.request('resources/webhooks/subscribe', params)).rejects.toThrow(ExtensionNotDeclaredError);
    expect(sent).toEqual(['server/discover']);
    await client.request('events/list');
    expect(sent).toEqual(['server/discover', 'events/list']);
  });
});
