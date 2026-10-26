// Level 2's collections: folders and a type's root by uri, templates and the listed target, each
// delivering its members' changes, and a catch-up by cursor that resets when A has dropped what it
// needed. Real timers, as in level 1's tests, and a clock that moves past A's cut-off window.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { McpError } from '../../src/client/mcp-client';
import type { ResourceChange } from '../../src/resource-webhooks-types';
import { newSecret } from '../../src/standard-webhooks';
import { signedIn, subscribeTarget, untilClosed, watch, write, type Party } from '../client/parties';
import { scenarios9and10, subscribedToInbox } from '../scenarios/collections';
import { newLane, type Lane } from './lane';
import { receiver, type Received } from './receiver';

describe('Scenarios 9 and 10: a folder', () => {
  it('subscribes to an empty inbox, hears a new member, and catches up by its cursor after an absence', () => scenarios9and10(newLane()));
});

describe('Scenario 10b: a cursor too old to serve', () => {
  it('answers a refresh naming a cursor older than a pruned deletion with every member, marked reset, and b drops the one it no longer lists', async () => {
    const run = await subscribedToInbox(newLane());
    const { a, inbox, copies, results } = run;
    let listener = await run.connect();
    await copies.refresh({ uri: inbox });
    const note43 = `${inbox}/note-43`;
    await write(a, note43, 'Buy milk');
    await vi.waitFor(() => expect(copies.get(note43)?.deleted).toBe(false));
    listener.close();
    await untilClosed(run.tier, run.b.clientId);
    const note44 = `${inbox}/note-44`;
    const n44v1 = await write(a, note44, 'Buy bread');
    await a.client.request('tools/call', { name: 'delete_note', arguments: { uri: note43 } });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      // Past the cut-off window, one write outside the inbox prunes the inbox's deletion.
      vi.setSystemTime(Date.now() + Number(env.CUTOFF_WINDOW_MS) + 1000);
      await write(a, `${run.tier.root}/notes/archive/note-9`, 'Archived');
      listener = await run.connect();
      const before = results.length;
      await copies.refresh({ uri: inbox });
      // A's retries to b may still be running and cross the refresh, which then refreshes again
      // from the reset's final cursor, so only the reset's own results are read.
      const reset = results.slice(before).filter((result) => result.reset === true);
      expect(results[before].reset).toBe(true);
      expect(reset.flatMap((result) => result.changes)).toEqual([{ uri: note44, form: 'notify', version: n44v1 }]);
      expect(copies.held()).toEqual([note44]);
      expect(copies.get(note44)).toEqual({ version: n44v1, deleted: false });
    } finally {
      vi.useRealTimers();
      listener.close();
    }
  });
});

// The criteria beyond the scenarios, each against a fake receiver.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const scheduleMs = env.RETRY_SCHEDULE_MS.split(',').map(Number).reduce((sum, delay) => sum + delay, 0);
const bodies = (received: Received[]) => received.map((each) => JSON.parse(each.body) as ResourceChange & { cursor?: unknown });

async function parties(): Promise<{ lane: Lane; a: Party; b: Party }> {
  const lane = newLane();
  return { lane, a: await signedIn(lane, 'a'), b: await signedIn(lane, 'b') };
}

/** Writes a list over HTTP, the one way A takes a list, and returns its version. */
async function writeList(lane: Lane, path: string, title: string): Promise<string> {
  const response = await lane.fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, items: [] }) });
  expect(response.status).toBeLessThan(300);
  return response.headers.get('ETag')!.slice(1, -1);
}

/** Wipes A, which raises its epoch, and signs `a` and `b` in again. */
async function wiped(lane: Lane): Promise<{ a: Party; b: Party }> {
  const page = await watch(lane, 'A');
  expect((await page.control('wipe')).type).toBe('done');
  page.close();
  return { a: await signedIn(lane, 'a'), b: await signedIn(lane, 'b') };
}

describe('a collection', () => {
  it("answers changes and a cursor, never a version, for an empty folder and for a type's root", async () => {
    const { lane, b } = await parties();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    for (const uri of [`${lane.root}/notes/inbox`, `${lane.root}/notes`]) {
      const result = await subscribeTarget(b, { uri }, endpoint.url(), newSecret());
      expect({ uri, changes: result.changes, cursor: typeof result.cursor, version: result.version }).toEqual({ uri, changes: [], cursor: 'string', version: undefined });
    }
  });

  it('lists every member that exists, and no deleted one, when no cursor is named', async () => {
    const { lane, a, b } = await parties();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const at = (n: number) => `${lane.root}/notes/inbox/note-${n}`;
    const kept = await write(a, at(1), 'Kept');
    await write(a, at(2), 'Deleted');
    await a.client.request('tools/call', { name: 'delete_note', arguments: { uri: at(2) } });
    const result = await subscribeTarget(b, { uri: `${lane.root}/notes/inbox` }, endpoint.url(), newSecret());
    expect(result.changes).toEqual([{ uri: at(1), form: 'notify', version: kept }]);
    expect(result).not.toHaveProperty('reset');
  });

  it('answers a cursor from before a Wipe, a malformed one, and one A never wrote with every member, marked reset', async () => {
    const lane = newLane();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const inbox = { uri: `${lane.root}/notes/inbox` };
    const at = (n: number) => `${lane.root}/notes/inbox/note-${n}`;
    let { a, b } = await wiped(lane);
    await write(a, at(1), 'Before the Wipe');
    const { cursor: before } = await subscribeTarget(b, inbox, endpoint.url(), newSecret());
    ({ a, b } = await wiped(lane));
    // The new epoch's stamps start again, so the old cursor's stamp names a row this epoch has.
    const two = await write(a, at(2), 'Two');
    const three = await write(a, at(3), 'Three');
    const every = [
      { uri: at(2), form: 'notify', version: two },
      { uri: at(3), form: 'notify', version: three },
    ];
    // A test of A's own cursors: a listing's, `l…`, in this epoch, with a path that is not UTF-8.
    const { cursor: now } = await subscribeTarget(b, inbox, endpoint.url(), newSecret());
    const malformed = `l${now!.slice(1)}.wA`;
    for (const cursor of [before, malformed, 'nonsense']) {
      const result = await subscribeTarget(b, inbox, endpoint.url(), newSecret(), { cursor });
      expect({ cursor, changes: result.changes, reset: result.reset }).toEqual({ cursor, changes: every, reset: true });
    }
  });

  it('serves a cursor past the window when the rows dropped after it were only older versions', async () => {
    const { lane, a, b } = await parties();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const secret = newSecret();
    const inbox = { uri: `${lane.root}/notes/inbox` };
    const note = `${lane.root}/notes/inbox/note-1`;
    const { cursor: older } = await subscribeTarget(b, inbox, endpoint.url(), secret);
    const gone = `${lane.root}/notes/archive/note-8`;
    await write(a, gone, 'Gone');
    await a.client.request('tools/call', { name: 'delete_note', arguments: { uri: gone } });
    const { cursor } = await subscribeTarget(b, inbox, endpoint.url(), secret);
    await write(a, note, 'One');
    const edited = await write(a, note, 'One, edited');
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      // Past the window, one write elsewhere drops note-8's deletion and note-1's first version.
      vi.setSystemTime(Date.now() + Number(env.CUTOFF_WINDOW_MS) + 1000);
      await write(a, `${lane.root}/notes/archive/note-9`, 'Archived');
      // The cursor from before the deletion shows the prune ran.
      expect((await subscribeTarget(b, inbox, endpoint.url(), secret, { cursor: older })).reset).toBe(true);
      const result = await subscribeTarget(b, inbox, endpoint.url(), secret, { cursor });
      expect(result.changes).toEqual([{ uri: note, form: 'notify', version: edited }]);
      expect(result).not.toHaveProperty('reset');
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers each write to a member once, under the member, and nothing for the folder, with no cursor', async () => {
    const { lane, a, b } = await parties();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    await subscribeTarget(b, { uri: `${lane.root}/notes/inbox` }, endpoint.url(), newSecret());
    const uri = `${lane.root}/notes/inbox/note-1`;
    const version = await write(a, uri, 'One');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    await sleep(scheduleMs);
    expect(bodies(endpoint.deliveries())).toEqual([{ uri, form: 'notify', version }]);
  });

  it('covers a write under inbox/sub/, and none under inbox-old/ or inbox2/, in its deliveries and its catch-up', async () => {
    const { lane, a, b } = await parties();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const at = (path: string) => `${lane.root}/notes/${path}`;
    const before = { old: await write(a, at('inbox-old/note-1'), 'Old'), two: await write(a, at('inbox2/note-1'), 'Two'), sub: await write(a, at('inbox/sub/note-1'), 'Sub') };
    const result = await subscribeTarget(b, { uri: at('inbox') }, endpoint.url(), newSecret());
    expect(result.changes).toEqual([{ uri: at('inbox/sub/note-1'), form: 'notify', version: before.sub }]);
    await write(a, at('inbox-old/note-2'), 'Old');
    await write(a, at('inbox2/note-2'), 'Two');
    const sub = await write(a, at('inbox/sub/note-2'), 'Sub');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    await sleep(scheduleMs);
    expect(bodies(endpoint.deliveries())).toEqual([{ uri: at('inbox/sub/note-2'), form: 'notify', version: sub }]);
  });

  it("carries each member's contents in a catch-up asking for full, from nothing and by its cursor", async () => {
    const { lane, a, b } = await parties();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const uri = `${lane.root}/notes/inbox/note-1`;
    const version = await write(a, uri, 'One');
    const secret = newSecret();
    const result = await subscribeTarget(b, { uri: `${lane.root}/notes/inbox` }, endpoint.url(), secret, { catchUp: 'full' });
    expect(result.changes).toEqual([{ uri, form: 'full', version, contents: [{ uri, mimeType: 'application/json', text: '{"title":"One","done":false}' }] }]);
    // And by its cursor, the changes since.
    const two = `${lane.root}/notes/inbox/note-2`;
    const twoVersion = await write(a, two, 'Two');
    const since = await subscribeTarget(b, { uri: `${lane.root}/notes/inbox` }, endpoint.url(), secret, { catchUp: 'full', cursor: result.cursor });
    expect(since.changes).toEqual([{ uri: two, form: 'full', version: twoVersion, contents: [{ uri: two, mimeType: 'application/json', text: '{"title":"Two","done":false}' }] }]);
  });

  it('matches {type} as one segment and {+path} as any depth, and refuses a template with another expression or an unmatched brace', async () => {
    const { lane, a, b } = await parties();
    const archives = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const deep = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    await subscribeTarget(b, { uriTemplate: `${lane.root}/{type}/archive` }, archives.url(), newSecret());
    await subscribeTarget(b, { uriTemplate: `${lane.root}/notes/{+path}/archive` }, deep.url(), newSecret());
    const note = await write(a, `${lane.root}/notes/archive/note-1`, 'Archived note');
    const list = await writeList(lane, '/lists/archive/list-1', 'Archived list');
    const deeper = await write(a, `${lane.root}/notes/x/archive/note-1`, 'Deeper than {type}');
    const nested = await write(a, `${lane.root}/notes/a/b/archive/note-1`, 'Nested');
    await vi.waitFor(() => expect(archives.deliveries()).toHaveLength(2));
    await vi.waitFor(() => expect(deep.deliveries()).toHaveLength(2));
    await sleep(scheduleMs);
    expect(bodies(archives.deliveries()).map(({ version }) => version).sort()).toEqual([note, list].sort());
    expect(bodies(deep.deliveries()).map(({ version }) => version).sort()).toEqual([deeper, nested].sort());
    for (const uriTemplate of [`${lane.root}/notes/{?q}`, `${lane.root}/notes/{a,b}`, `${lane.root}/notes/{path*}`, `${lane.root}/notes/{type`, `${lane.root}/notes/type}`]) {
      const refused = await subscribeTarget(b, { uriTemplate }, archives.url(), newSecret()).then(
        () => undefined,
        (error: McpError) => ({ code: error.code, data: error.data }),
      );
      expect(refused).toEqual({ code: -32026, data: { feature: 'uriTemplate', value: uriTemplate } });
    }
  });

  it('catches up a template and a listed target with exactly what each covers', async () => {
    const { lane, a, b } = await parties();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const at = (path: string) => `${lane.root}${path}`;
    const archived = await write(a, at('/notes/archive/note-1'), 'Archived');
    const list = await writeList(lane, '/lists/archive/list-1', 'Archived list');
    const inboxed = await write(a, at('/notes/inbox/note-2'), 'Inbox');
    await write(a, at('/notes/x/archive/note-3'), 'Deeper than {type}');
    const template = await subscribeTarget(b, { uriTemplate: at('/{type}/archive') }, endpoint.url(), newSecret());
    expect(template.changes).toEqual([
      { uri: at('/lists/archive/list-1'), form: 'notify', version: list },
      { uri: at('/notes/archive/note-1'), form: 'notify', version: archived },
    ]);
    const listed = await subscribeTarget(b, { listed: true }, endpoint.url(), newSecret());
    expect(listed.changes).toEqual([
      { uri: at('/lists/archive/list-1'), form: 'notify', version: list },
      { uri: at('/notes/inbox/note-2'), form: 'notify', version: inboxed },
    ]);
  });

  it("covers what resources/list returns with a listed target: the inbox's notes and every list, and no archived note", async () => {
    const { lane, a, b } = await parties();
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    await subscribeTarget(b, { listed: true }, endpoint.url(), newSecret());
    const inboxed = await write(a, `${lane.root}/notes/inbox/note-1`, 'Inbox');
    const list = await writeList(lane, '/lists/list-1', 'Groceries');
    await write(a, `${lane.root}/notes/archive/note-1`, 'Archived');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(2));
    await sleep(scheduleMs);
    expect(bodies(endpoint.deliveries()).map(({ version }) => version).sort()).toEqual([inboxed, list].sort());
  });
});
