// The `patch` form: where a delivery's patch starts, across a replacement and a restart of A, a
// catch-up's patch from the version named or from the cursor, and `full` when no patch can start.
// A receiver the test answers for stands in for B, and b's copies take what it is handed.
import { abortAllDurableObjects } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { Copies, type Copy } from '../../src/client/copies';
import type { ResourceChange, ResourceWebhookSubscribeResult } from '../../src/resource-webhooks-types';
import { newSecret } from '../../src/standard-webhooks';
import { signedIn, subscribeTarget, watch, write, type Party } from '../client/parties';
import { newLane, type Lane } from './lane';
import { receiver, type Received } from './receiver';

const body = (received: Received) => JSON.parse(received.body) as ResourceChange & { fromVersion?: string; mergePatch?: unknown };
const note = (title: string, done = false) => ({ title, done });

async function parties(): Promise<{ lane: Lane; a: Party; b: Party; uri: string }> {
  const lane = newLane();
  return { lane, a: await signedIn(lane, 'a'), b: await signedIn(lane, 'b'), uri: `${lane.root}/notes/inbox/note-1` };
}

/** A receiver that answers each delivery with whatever status the test last set. */
function switchable() {
  let status = 200;
  const endpoint = receiver({ deliveries: () => new Response(null, { status }) });
  return { endpoint, answer: (next: number) => (status = next) };
}

describe('a patch delivery', () => {
  it('starts from the version before it, and one that replaces a pending delivery starts where that one did', async () => {
    const { lane, a, b, uri } = await parties();
    // Retries a second apart, so v4 surely replaces v3 while v3 waits.
    const page = await watch(lane, 'A');
    expect(await page.control('schedule', { delaysMs: [1000, 1000, 1000] })).toMatchObject({ type: 'done' });
    const { endpoint, answer } = switchable();
    const v1 = await write(a, uri, 'One');
    await subscribeTarget(b, { uri }, endpoint.url(), newSecret(), { form: 'patch' });
    const v2 = await write(a, uri, 'Two');
    await vi.waitFor(() => expect(endpoint.deliveries().map(body)).toEqual([{ uri, form: 'patch', version: v2, fromVersion: v1, mergePatch: { title: 'Two' } }]));
    answer(503);
    const v3 = await write(a, uri, 'Three');
    await vi.waitFor(() => expect(endpoint.deliveries().map(body).map(({ version }) => version)).toContain(v3));
    const v4 = await write(a, uri, 'Four');
    await vi.waitFor(() => expect(endpoint.deliveries().map(body).map(({ version }) => version)).toContain(v4));
    answer(200);
    // v4's retry, a second later, is the attempt that gets through.
    const fours = () => endpoint.deliveries().map(body).filter(({ version }) => version === v4);
    await vi.waitFor(() => expect(fours().length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    // b got v2 and never v3, so every attempt of v4 patches from v2.
    expect(fours().every((change) => change.fromVersion === v2)).toBe(true);
    expect(fours()[0].mergePatch).toEqual({ title: 'Four' });
  });

  it("starts from the version before it once a restart of A drops the pending delivery, and b catches up", async () => {
    const { a, b, uri } = await parties();
    const { endpoint, answer } = switchable();
    const secret = newSecret();
    await write(a, uri, 'One');
    const copies = new Copies((target, { version }) => subscribeTarget(b, target, endpoint.url(), secret, { form: 'patch', catchUp: 'full', ...(version ? { version } : {}) }));
    await copies.refresh({ uri });
    const v2 = await write(a, uri, 'Two');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    copies.deliver(body(endpoint.deliveries()[0]));
    expect(copies.get(uri)?.version).toBe(v2);
    answer(503);
    // v3 changes `done` as well, so a patch from v3 applied to v2 would not give v4.
    const v3 = await write(a, uri, 'Three', true);
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(2));
    await abortAllDurableObjects();
    answer(200);
    const v4 = await write(a, uri, 'Four', true);
    await vi.waitFor(() => expect(endpoint.deliveries().map(body).map(({ version }) => version)).toContain(v4));
    const four = endpoint.deliveries().map(body).find(({ version }) => version === v4)!;
    expect(four).toMatchObject({ form: 'patch', fromVersion: v3 });
    // b holds v2, so it cannot apply the patch, and refreshes, naming v2.
    copies.deliver(four);
    await vi.waitFor(() => expect(copies.get(uri)).toEqual({ version: v4, deleted: false, contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(note('Four', true)) }] }));
  });

  it('goes full for a resource the change created', async () => {
    const { lane, a, b } = await parties();
    const { endpoint } = switchable();
    await subscribeTarget(b, { uri: `${lane.root}/notes/inbox` }, endpoint.url(), newSecret(), { form: 'patch' });
    const uri = `${lane.root}/notes/inbox/note-9`;
    const v1 = await write(a, uri, 'New');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    expect(body(endpoint.deliveries()[0])).toEqual({ uri, form: 'full', version: v1, contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(note('New')) }] });
  });
});

describe('a patch catch-up', () => {
  it('patches from the version named, and carries the contents for one A has pruned', async () => {
    const { lane, a, b, uri } = await parties();
    const { endpoint } = switchable();
    const secret = newSecret();
    const v1 = await write(a, uri, 'One');
    const v2 = await write(a, uri, 'Two');
    const patched = await subscribeTarget(b, { uri }, endpoint.url(), secret, { catchUp: 'patch', version: v1 });
    expect({ version: patched.version, fromVersion: patched.fromVersion, mergePatch: patched.mergePatch, contents: patched.contents }).toEqual({ version: v2, fromVersion: v1, mergePatch: { title: 'Two' }, contents: undefined });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      // Past the window, v3 prunes v1 and v2, which it supersedes, and v4 keeps v3, so A still
      // has a version to patch from, just not the one named.
      vi.setSystemTime(Date.now() + Number(env.CUTOFF_WINDOW_MS) + 1000);
      await write(a, uri, 'Three');
      const v4 = await write(a, uri, 'Four');
      const whole = await subscribeTarget(b, { uri }, endpoint.url(), secret, { catchUp: 'patch', version: v1 });
      expect({ version: whole.version, fromVersion: whole.fromVersion, contents: whole.contents }).toEqual({ version: v4, fromVersion: undefined, contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(note('Four')) }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is applied by b to the version it named', async () => {
    const { a, b, uri } = await parties();
    const { endpoint } = switchable();
    const secret = newSecret();
    await write(a, uri, 'One');
    const copies = new Copies((target, { version }) => subscribeTarget(b, target, endpoint.url(), secret, { catchUp: 'patch', ...(version ? { version } : {}) }));
    // With no version named, the first result carries the contents.
    await copies.refresh({ uri });
    const v2 = await write(a, uri, 'Two', true);
    await copies.refresh({ uri });
    expect(copies.get(uri)?.version).toBe(v2);
    expect(JSON.parse((copies.get(uri)!.contents![0] as { text: string }).text)).toEqual(note('Two', true));
  });

  it("patches a collection's members from their versions at the cursor, and b reads one again when it holds another", async () => {
    const { lane, a, b, uri } = await parties();
    const { endpoint } = switchable();
    const secret = newSecret();
    const inbox = { uri: `${lane.root}/notes/inbox` };
    await write(a, uri, 'One');
    const reads: string[] = [];
    const refreshes: (string | undefined)[] = [];
    const copies = new Copies(
      async (target, { cursor }) => {
        refreshes.push(cursor);
        return subscribeTarget(b, target, endpoint.url(), secret, { form: 'patch', catchUp: 'patch', ...(cursor ? { cursor } : {}) }) as Promise<ResourceWebhookSubscribeResult>;
      },
      async (member): Promise<Copy> => {
        reads.push(member);
        const response = await lane.send(new Request(member));
        return { version: response.headers.get('ETag')!.slice(1, -1), deleted: false, contents: [{ uri: member, mimeType: 'application/json', text: await response.text() }] };
      },
    );
    // A listing from nothing carries note-1 whole, and its cursor stands at v1.
    await copies.refresh(inbox);
    const v2 = await write(a, uri, 'Two');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
    copies.deliver(body(endpoint.deliveries()[0]));
    expect(copies.get(uri)?.version).toBe(v2);
    // b misses v3, and catches up from its cursor, where note-1 was at v1, which b no longer holds.
    const v3 = await write(a, uri, 'Three');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(2));
    await copies.refresh(inbox);
    await vi.waitFor(() => expect(copies.get(uri)?.version).toBe(v3));
    expect(JSON.parse((copies.get(uri)!.contents![0] as { text: string }).text)).toEqual(note('Three'));
    expect(reads).toEqual([uri]);
    expect(refreshes).toHaveLength(2);
  });
});

describe("each form's bytes on the wire", () => {
  it('measures a note edited and a list of 100 items with one item changed, and a list patch carries the whole array', async () => {
    const { lane, a, b } = await parties();
    const forms = ['notify', 'full', 'patch'] as const;
    const endpoints = Object.fromEntries(forms.map((form) => [form, switchable().endpoint]));
    const noteUri = `${lane.root}/notes/inbox/note-1`;
    const listPath = '/lists/list-1';
    const items = Array.from({ length: 100 }, (_, index) => `item ${index + 1}`);
    const putList = async (list: { title: string; items: string[] }) => {
      const response = await lane.fetch(listPath, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) });
      expect(response.status).toBeLessThan(300);
    };
    await write(a, noteUri, 'Buy oat milk');
    await putList({ title: 'Groceries', items });
    // One principal holds five subscriptions at most in the lane, so c watches the list.
    const c = await signedIn(lane, 'c');
    for (const form of forms) {
      await subscribeTarget(b, { uri: noteUri }, endpoints[form].url(`/${form}`), newSecret(), { form });
      await subscribeTarget(c, { uri: `${lane.root}${listPath}` }, endpoints[form].url(`/${form}`), newSecret(), { form });
    }
    await write(a, noteUri, 'Buy oat milk', true);
    await putList({ title: 'Groceries', items: items.map((item, index) => (index === 49 ? 'item 50, organic' : item)) });
    await vi.waitFor(() => forms.forEach((form) => expect(endpoints[form].deliveries()).toHaveLength(2)));
    const bytes = Object.fromEntries(forms.map((form) => [form, endpoints[form].deliveries().map((received) => new TextEncoder().encode(received.body).length)]));
    // The figures sep-notes.md's Findings report, printed for the record.
    console.log(`bytes on the wire, [note, list]: ${JSON.stringify(bytes)}`);
    const [note, list] = [0, 1].map((index) => Object.fromEntries(forms.map((form) => [form, bytes[form][index]])));
    expect(note.patch).toBeLessThan(note.full);
    expect(body(endpoints.patch.deliveries()[1]).mergePatch).toEqual({ items: items.map((item, index) => (index === 49 ? 'item 50, organic' : item)) });
    // The array goes whole, so the patch saves little more than full's escaping of the text.
    expect(list.patch).toBeGreaterThan(0.7 * list.full);
  });
});

