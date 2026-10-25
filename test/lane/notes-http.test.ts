import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionStore } from '../../src/server-role/version-store';
import { newLane, type Lane } from './lane';

const BUY_MILK = '{"title":"Buy milk"}';

function put(lane: Lane, path: string, body: string, headers: Record<string, string> = {}) {
  return lane.fetch(path, { method: 'PUT', body, headers: { 'Content-Type': 'application/json', ...headers } });
}

// A's rows, read below the public API: no HTTP response shows a superseded row, a deletion's
// row or a pruned one, and these criteria are about exactly those.
function rows(lane: Lane) {
  return runInDurableObject(lane.stub, (_instance, state) =>
    state.storage.sql
      .exec<{ stamp: number; path: string; deleted: number }>('SELECT stamp, path, deleted FROM Versions ORDER BY stamp')
      .toArray(),
  );
}

describe('Scenario 1b: polling with plain HTTP', () => {
  it('versions a note with ETags, and answers a current one with 304', async () => {
    const lane = newLane();
    const created = await put(lane, '/notes/inbox/note-42', BUY_MILK, { 'If-None-Match': '*' });
    expect(created.status).toBe(201);
    const v1 = created.headers.get('ETag')!;
    expect(v1).toMatch(/^"e0\.\d+"$/);

    const first = await lane.fetch('/notes/inbox/note-42');
    expect(first.status).toBe(200);
    expect(first.headers.get('ETag')).toBe(v1);
    expect(await first.text()).toBe(BUY_MILK);

    const unchanged = await lane.fetch('/notes/inbox/note-42', { headers: { 'If-None-Match': v1 } });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('ETag')).toBe(v1);
    expect(await unchanged.text()).toBe('');

    const due = '{"title":"Buy milk","due":"2026-10-24"}';
    const replaced = await put(lane, '/notes/inbox/note-42', due, { 'If-Match': v1 });
    expect(replaced.status).toBe(204);
    const v2 = replaced.headers.get('ETag')!;
    expect(v2).toMatch(/^"e0\.\d+"$/);
    expect(v2).not.toBe(v1);

    const changed = await lane.fetch('/notes/inbox/note-42', { headers: { 'If-None-Match': v1 } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('ETag')).toBe(v2);
    expect(await changed.text()).toBe(due);
  });
});

describe('conditional requests, as RFC 9110 orders them', () => {
  it('answers If-None-Match: * and a weak tag on a GET with 304, and a HEAD with headers only', async () => {
    const lane = newLane();
    const v1 = (await put(lane, '/notes/inbox/note-42', BUY_MILK)).headers.get('ETag')!;
    expect((await lane.fetch('/notes/inbox/note-42', { headers: { 'If-None-Match': '*' } })).status).toBe(304);
    expect((await lane.fetch('/notes/inbox/note-42', { headers: { 'If-None-Match': `"e0.0", W/${v1}` } })).status).toBe(304);
    expect((await lane.fetch('/notes/inbox/note-42', { headers: { 'If-None-Match': '"e0.0"' } })).status).toBe(200);

    const head = await lane.fetch('/notes/inbox/note-42', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('ETag')).toBe(v1);
    expect(await head.text()).toBe('');
  });

  it('answers a GET under a stale If-Match with 412, and never lets a weak tag match it', async () => {
    const lane = newLane();
    const v1 = (await put(lane, '/notes/inbox/note-42', BUY_MILK)).headers.get('ETag')!;
    expect((await lane.fetch('/notes/inbox/note-42', { headers: { 'If-Match': '"e0.0"' } })).status).toBe(412);
    expect((await lane.fetch('/notes/inbox/note-42', { headers: { 'If-Match': `W/${v1}` } })).status).toBe(412);
    expect((await lane.fetch('/notes/inbox/note-42', { headers: { 'If-Match': v1 } })).status).toBe(200);
  });

  it('refuses If-Match: * on a note that does not exist with 412', async () => {
    const lane = newLane();
    expect((await put(lane, '/notes/inbox/note-42', BUY_MILK, { 'If-Match': '*' })).status).toBe(412);
    expect(await rows(lane)).toEqual([]);
  });

  it('answers a DELETE of a missing note with 404 whatever its If-Match says', async () => {
    const lane = newLane();
    expect((await lane.fetch('/notes/inbox/note-42', { method: 'DELETE', headers: { 'If-Match': '"e0.1"' } })).status).toBe(404);
  });

  it('refuses a DELETE under a stale If-Match with 412', async () => {
    const lane = newLane();
    const v1 = (await put(lane, '/notes/inbox/note-42', BUY_MILK)).headers.get('ETag')!;
    await put(lane, '/notes/inbox/note-42', '{"title":"Buy oat milk"}', { 'If-Match': v1 });
    const stale = await lane.fetch('/notes/inbox/note-42', { method: 'DELETE', headers: { 'If-Match': v1 } });
    expect(stale.status).toBe(412);
    expect((await lane.fetch('/notes/inbox/note-42')).status).toBe(200);
  });
});

describe('writes', () => {
  it('refuses a PUT under a stale If-Match with 412, and leaves the rows as they were', async () => {
    const lane = newLane();
    const v1 = (await put(lane, '/notes/inbox/note-42', BUY_MILK)).headers.get('ETag')!;
    await put(lane, '/notes/inbox/note-42', '{"title":"Buy oat milk"}', { 'If-Match': v1 });
    const before = await rows(lane);

    const stale = await put(lane, '/notes/inbox/note-42', '{"title":"Buy soy milk"}', { 'If-Match': v1 });

    expect(stale.status).toBe(412);
    expect(await rows(lane)).toEqual(before);
    expect(await (await lane.fetch('/notes/inbox/note-42')).text()).toBe('{"title":"Buy oat milk"}');
  });

  it('refuses a PUT under If-None-Match: * when the note exists, with 412', async () => {
    const lane = newLane();
    await put(lane, '/notes/inbox/note-42', BUY_MILK);
    const before = await rows(lane);

    const again = await put(lane, '/notes/inbox/note-42', '{"title":"Buy soy milk"}', { 'If-None-Match': '*' });

    expect(again.status).toBe(412);
    expect(await rows(lane)).toEqual(before);
  });

  it('refuses a member the type does not have with 400', async () => {
    const lane = newLane();
    const response = await put(lane, '/notes/inbox/note-42', '{"title":"Buy milk","colour":"blue"}');
    expect(response.status).toBe(400);
    expect(await rows(lane)).toEqual([]);
  });

  it('refuses a body that is not JSON, or not UTF-8, with 400', async () => {
    const lane = newLane();
    expect((await put(lane, '/notes/inbox/note-42', '{"title":')).status).toBe(400);
    // A JSON string holding bytes that are not UTF-8, which a lenient decoder would replace.
    const bytes = new Uint8Array([...new TextEncoder().encode('{"title":"'), 0xff, 0xfe, ...new TextEncoder().encode('"}')]);
    expect((await lane.fetch('/notes/inbox/note-42', { method: 'PUT', body: bytes })).status).toBe(400);
    expect(await rows(lane)).toEqual([]);
  });

  it('keeps a list as sent, and refuses one whose items are not strings', async () => {
    const lane = newLane();
    const groceries = '{ "title": "Groceries", "items": ["oat milk"] }';
    expect((await put(lane, '/lists/list-7', groceries)).status).toBe(201);
    expect(await (await lane.fetch('/lists/list-7')).text()).toBe(groceries);
    expect((await put(lane, '/lists/list-7', '{"title":"Groceries","items":[1]}')).status).toBe(400);
    // A list's body is not a note, so the type comes from the path.
    expect((await put(lane, '/lists/list-8', BUY_MILK)).status).toBe(400);
  });

  it('refuses a write to a folder with 405', async () => {
    const lane = newLane();
    for (const method of ['PUT', 'DELETE']) {
      const response = await lane.fetch('/notes/inbox', { method, body: method === 'PUT' ? BUY_MILK : undefined });
      expect({ method, status: response.status, allow: response.headers.get('Allow') }).toEqual({ method, status: 405, allow: 'GET, HEAD' });
    }
  });

  it('refuses a method it does not take with 405, though the edge never sends one', async () => {
    const lane = newLane();
    // Below the public API: the edge answers 404 to a POST before A sees it, so only a
    // request made straight to A's stub reaches A's own refusal.
    const response = await lane.stub.fetch(new Request(`${lane.root}/notes/inbox/note-42`, { method: 'POST', body: BUY_MILK }));
    expect(response.status).toBe(405);
    expect(await rows(lane)).toEqual([]);
  });

  it('refuses a member that is null with 400', async () => {
    const lane = newLane();
    const response = await put(lane, '/notes/inbox/note-42', '{"title":"Buy milk","done":null}');
    expect(response.status).toBe(400);
    expect(await rows(lane)).toEqual([]);
  });

  it('refuses a body over 1 MiB with 413', async () => {
    const lane = newLane();
    // Valid JSON for a note, so only its size can refuse it.
    const body = JSON.stringify({ title: 'x'.repeat(1024 * 1024) });
    const response = await put(lane, '/notes/inbox/note-42', body);
    expect(response.status).toBe(413);
    expect(await rows(lane)).toEqual([]);
  });

  it('refuses a streamed body over 1 MiB, which declares no Content-Length, with 413', async () => {
    const lane = newLane();
    const half = new TextEncoder().encode(`{"title":"${'x'.repeat(600 * 1024)}`);
    const rest = new TextEncoder().encode(`${'x'.repeat(600 * 1024)}"}`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(half);
        controller.enqueue(rest);
        controller.close();
      },
    });
    const request = new Request(`${lane.root}/notes/inbox/note-42`, { method: 'PUT', body });
    expect(request.headers.get('Content-Length')).toBeNull();
    const response = await lane.fetch('/notes/inbox/note-42', { method: 'PUT', body: request.body });
    expect(response.status).toBe(413);
    expect(await rows(lane)).toEqual([]);
  });

  it('accepts a body of exactly 1 MiB', async () => {
    const lane = newLane();
    const padding = 1024 * 1024 - '{"title":""}'.length;
    const response = await put(lane, '/notes/inbox/note-42', JSON.stringify({ title: 'x'.repeat(padding) }));
    expect(response.status).toBe(201);
  });
});

describe('deletion', () => {
  it('adds a row marked deleted, and a later GET answers 404', async () => {
    const lane = newLane();
    await put(lane, '/notes/inbox/note-42', BUY_MILK);

    const deleted = await lane.fetch('/notes/inbox/note-42', { method: 'DELETE' });

    expect(deleted.status).toBe(204);
    expect((await rows(lane)).map(({ path, deleted }) => ({ path, deleted }))).toEqual([
      { path: '/notes/inbox/note-42', deleted: 0 },
      { path: '/notes/inbox/note-42', deleted: 1 },
    ]);
    expect((await lane.fetch('/notes/inbox/note-42')).status).toBe(404);
    expect((await lane.fetch('/notes/inbox/note-42', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('folders', () => {
  it("lists its members' URIs with no ETag, and nothing from a folder that shares its prefix", async () => {
    const lane = newLane();
    await put(lane, '/notes/inbox/note-42', BUY_MILK);
    await put(lane, '/notes/inbox/errands/note-43', '{"title":"Post office"}');
    await put(lane, '/notes/inbox2/note-44', '{"title":"Not in the inbox"}');
    await put(lane, '/notes/inbox-old/note-46', '{"title":"Nor this"}');
    await put(lane, '/notes/inbox/note-45', '{"title":"Gone"}');
    await lane.fetch('/notes/inbox/note-45', { method: 'DELETE' });

    const inbox = await lane.fetch('/notes/inbox');

    expect(inbox.status).toBe(200);
    expect(inbox.headers.get('ETag')).toBeNull();
    expect(await inbox.json()).toEqual({
      members: [`${lane.root}/notes/inbox/errands/note-43`, `${lane.root}/notes/inbox/note-42`],
    });
    expect(await (await lane.fetch('/notes')).json()).toEqual({
      members: [
        `${lane.root}/notes/inbox-old/note-46`,
        `${lane.root}/notes/inbox/errands/note-43`,
        `${lane.root}/notes/inbox/note-42`,
        `${lane.root}/notes/inbox2/note-44`,
      ],
    });
  });
});

describe('pruning, with the cut-off window at one minute', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a cut-off window that is not a positive number before any write', async () => {
    const lane = newLane();
    // Below the public API: the window comes from a binding, so only a store built by hand
    // can be given a bad one.
    const thrown = await runInDurableObject(lane.stub, (_instance, state) =>
      [NaN, 0, -1].map((cutoffWindowMs) => {
        try {
          new VersionStore(state.storage.sql, { cutoffWindowMs });
          return 'accepted';
        } catch (error) {
          return (error as Error).name;
        }
      }),
    );
    expect(thrown).toEqual(['RangeError', 'RangeError', 'RangeError']);
  });

  it("drops rows older than the window, a deletion's among them, but keeps each live resource's newest", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const lane = newLane();
    await put(lane, '/notes/inbox/note-1', '{"title":"One"}');
    await put(lane, '/notes/inbox/note-1', '{"title":"One, edited"}');
    await put(lane, '/notes/inbox/note-2', '{"title":"Two"}');
    await lane.fetch('/notes/inbox/note-2', { method: 'DELETE' });
    const before = await rows(lane);
    expect(before).toHaveLength(4);

    vi.setSystemTime(Date.now() + 2 * 60_000);
    await put(lane, '/notes/inbox/note-3', '{"title":"Three"}');

    const after = await rows(lane);
    expect(after.map(({ path, deleted }) => ({ path, deleted }))).toEqual([
      { path: '/notes/inbox/note-1', deleted: 0 },
      { path: '/notes/inbox/note-3', deleted: 0 },
    ]);
    expect(after[0].stamp).toBe(before[1].stamp);
    expect(await (await lane.fetch('/notes/inbox/note-1')).text()).toBe('{"title":"One, edited"}');
  });

  it('never gives a note written again a version it had before, even once the window has pruned them', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const lane = newLane();
    const v1 = (await put(lane, '/notes/inbox/note-1', '{"title":"One"}')).headers.get('ETag');
    await put(lane, '/notes/inbox/note-2', '{"title":"Two"}');
    await lane.fetch('/notes/inbox/note-1', { method: 'DELETE' });
    // The deletion's version, which no HTTP response carries.
    const deletion = (await rows(lane)).at(-1)!;
    expect(deletion).toMatchObject({ path: '/notes/inbox/note-1', deleted: 1 });

    vi.setSystemTime(Date.now() + 2 * 60_000);
    const again = (await put(lane, '/notes/inbox/note-1', '{"title":"One, again"}')).headers.get('ETag');

    // The window pruned the deletion, so its stamp was free for SQLite to hand out again.
    expect((await rows(lane)).map(({ stamp }) => stamp)).not.toContain(deletion.stamp);
    expect(again).not.toBe(v1);
    expect(again).not.toBe(`"e0.${deletion.stamp}"`);
  });
});
