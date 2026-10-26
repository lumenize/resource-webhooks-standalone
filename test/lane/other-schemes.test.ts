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

/** Writes A's list at the path the scheme maps `lists:///inbox/groceries` to, and returns its version. */
async function putGroceries(lane: Lane, items: string[]): Promise<string> {
  const response = await lane.fetch('/lists/inbox/list-groceries', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Groceries', items }) });
  expect(response.status).toBeLessThan(300);
  return response.headers.get('ETag')!.slice(1, -1);
}

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
