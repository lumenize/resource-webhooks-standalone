// A resource without an `https` URI: A's lists again, under a scheme of A's own, as
// `lists:///inbox/groceries`, which only `resources/read` reaches. Its version comes in each read
// entry's `_meta`, as it does for every read A serves.
import { describe, expect, it, vi } from 'vitest';
import { McpError } from '../../src/client/mcp-client';
import { RESOURCE_VERSION_META_KEY, type ResourceChange } from '../../src/resource-webhooks-types';
import { newSecret } from '../../src/standard-webhooks';
import { signedIn, subscribeTarget, versioned, write } from '../client/parties';
import { newLane, type Lane } from './lane';
import { receiver } from './receiver';

const GROCERIES = 'lists:///inbox/groceries';

/** Writes one of A's lists by its `https` path, and returns its version. */
async function putList(lane: Lane, path: string, items: string[]): Promise<string> {
  const response = await lane.fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Groceries', items }) });
  expect(response.status).toBeLessThan(300);
  return response.headers.get('ETag')!.slice(1, -1);
}

/** Writes the list the scheme maps `lists:///inbox/groceries` to. */
const putGroceries = (lane: Lane, items: string[]) => putList(lane, '/lists/inbox/list-groceries', items);

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: McpError) => ({ code: error.code, data: error.data }),
  );

describe('a list under A’s own scheme', () => {
  it('reads with its version in _meta, under the URI it was named by, and subscribes', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const version = await putGroceries(lane, ['oat milk']);
    const read = await b.client.request<{ resultType: string; contents: unknown[] }>('resources/read', { uri: GROCERIES });
    expect(read.contents).toEqual([{ uri: GROCERIES, mimeType: 'application/json', text: '{"title":"Groceries","items":["oat milk"]}', ...versioned(version) }]);
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const result = await subscribeTarget(b, { uri: GROCERIES }, endpoint.url(), newSecret());
    expect({ id: result.id, version: result.version }).toEqual({ id: expect.stringMatching(/^sub_/), version });
    // The scheme names a list by every URI with usable segments, and A serves no other scheme.
    for (const uri of ['lists:///', 'lists:///inbox//groceries', 'lists:///inbox/gro cer', 'files:///inbox/groceries']) {
      expect(await refusal(subscribeTarget(b, { uri }, endpoint.url(), newSecret()))).toEqual({ code: -32602, data: { uri } });
    }
  });

  it('delivers notify under its own URI with the version a quiet read then names in _meta', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    await putGroceries(lane, ['oat milk']);
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    await subscribeTarget(b, { uri: GROCERIES }, endpoint.url(), newSecret());
    const version = await putGroceries(lane, ['oat milk', 'bread']);
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    const delivered = JSON.parse(endpoint.deliveries()[0].body) as ResourceChange;
    expect(delivered).toEqual({ uri: GROCERIES, form: 'notify', version });
    const read = await b.client.request<{ resultType: string; contents: { _meta?: Record<string, unknown> }[] }>('resources/read', { uri: GROCERIES });
    expect(read.contents[0]._meta?.[RESOURCE_VERSION_META_KEY]).toBe(delivered.version);
  });

  it('delivers in full under the URI the subscription named, and the https URI to a subscription naming that', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    await putGroceries(lane, ['oat milk']);
    const scheme = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const https = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const httpsUri = `${lane.root}/lists/inbox/list-groceries`;
    await subscribeTarget(b, { uri: GROCERIES }, scheme.url(), newSecret(), { form: 'full' });
    await subscribeTarget(b, { uri: httpsUri }, https.url(), newSecret());
    const version = await putGroceries(lane, ['bread']);
    await vi.waitFor(() => expect([scheme.deliveries().length, https.deliveries().length]).toEqual([1, 1]));
    expect(JSON.parse(scheme.deliveries()[0].body)).toEqual({ uri: GROCERIES, form: 'full', version, contents: [{ uri: GROCERIES, mimeType: 'application/json', text: '{"title":"Groceries","items":["bread"]}', ...versioned(version) }] });
    expect(JSON.parse(https.deliveries()[0].body)).toEqual({ uri: httpsUri, form: 'notify', version });
  });
});

describe('every read A serves', () => {
  it("names each entry's version in _meta, a folder's members included", async () => {
    const lane = newLane();
    const a = await signedIn(lane, 'a');
    const one = await write(a, `${lane.root}/notes/inbox/note-1`, 'One');
    const two = await write(a, `${lane.root}/notes/inbox/note-2`, 'Two');
    const read = await a.client.request<{ resultType: string; contents: { uri: string; _meta?: Record<string, unknown> }[] }>('resources/read', { uri: `${lane.root}/notes/inbox` });
    expect(read.contents.map((entry) => [entry.uri, entry._meta?.[RESOURCE_VERSION_META_KEY]])).toEqual([
      [`${lane.root}/notes/inbox/note-1`, one],
      [`${lane.root}/notes/inbox/note-2`, two],
    ]);
  });
});

describe('a list under A’s own scheme, as a collection or by a template', () => {
  it('reaches a subscription naming a list above it, under its own lists URI (R18)', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    // lists:///inbox is the list `inbox`, and lists:///inbox/groceries sits under it.
    await subscribeTarget(b, { uri: 'lists:///inbox' }, endpoint.url(), newSecret());
    const version = await putGroceries(lane, ['oat milk']);
    await vi.waitFor(() => expect(endpoint.deliveries().map((received) => JSON.parse(received.body))).toEqual([{ uri: GROCERIES, form: 'notify', version }]));
  });

  it('matches a template by the lists URI, in its catch-up and its deliveries (R19)', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const first = await putGroceries(lane, ['oat milk']);
    const result = await subscribeTarget(b, { uriTemplate: 'lists:///inbox/{name}' }, endpoint.url(), newSecret());
    expect(result.changes).toEqual([{ uri: GROCERIES, form: 'notify', version: first }]);
    const second = await putGroceries(lane, ['bread']);
    await vi.waitFor(() => expect(endpoint.deliveries().map((received) => JSON.parse(received.body))).toEqual([{ uri: GROCERIES, form: 'notify', version: second }]));
  });

  it('catches up, patches, deletes and unsubscribes under the lists URI', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const first = await putGroceries(lane, ['oat milk']);
    const caughtUp = await subscribeTarget(b, { uri: GROCERIES }, endpoint.url(), newSecret(), { form: 'patch', catchUp: 'full' });
    expect(caughtUp.contents).toEqual([{ uri: GROCERIES, mimeType: 'application/json', text: '{"title":"Groceries","items":["oat milk"]}', ...versioned(first) }]);
    const second = await putGroceries(lane, ['bread']);
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    expect(JSON.parse(endpoint.deliveries()[0].body)).toEqual({ uri: GROCERIES, form: 'patch', version: second, fromVersion: first, mergePatch: { items: ['bread'] } });
    const deleted = await lane.fetch('/lists/inbox/list-groceries', { method: 'DELETE' });
    expect(deleted.status).toBeLessThan(300);
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(2));
    expect(JSON.parse(endpoint.deliveries()[1].body)).toMatchObject({ uri: GROCERIES, form: 'notify', deleted: true });
    await b.client.request('resources/webhooks/unsubscribe', { uri: GROCERIES, delivery: { url: endpoint.url() } });
    await putGroceries(lane, ['eggs']);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(endpoint.deliveries()).toHaveLength(2);
  });
});

