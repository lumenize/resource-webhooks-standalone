// The demo page in Chromium, where production serves it: the Worker's own origin over https. One
// narrative walks beats 1 to 13 of demo-script.md through the page's controls, and checks all
// four boxes after each beat: what each party holds, A's and B's as they reported it, and the
// messages each saw during the beat.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

type Party = 'a' | 'A' | 'B' | 'b';
const PARTIES: Party[] = ['a', 'A', 'B', 'b'];
const origin = inject('origin');
const operatorToken = inject('operatorToken');
const heartbeatMs = inject('heartbeatMs');
const root = `${origin}/server/A`;
const WAIT = { timeout: 20_000, interval: 50 };
// A's retries for the demo, set through the page: three, so an absence outlasts them in seconds.
const SCHEDULE = [800, 800, 800];
const SECRET = 'whsec_…(32 bytes)';

let browser: Browser;
let page: Page;
// Every bearer token the page sent to A's MCP endpoint, so a test can try an old one, every URL
// it asked for, none of which may carry the operator token, and every error the page threw.
const tokens = new Set<string>();
const urls: string[] = [];
const errors: string[] = [];
let policy: string | undefined;

beforeAll(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', async (request) => {
    urls.push(request.url());
    if (!request.url().endsWith('/server/A/mcp')) return;
    const authorization = (await request.allHeaders()).authorization;
    if (authorization) tokens.add(authorization);
  });
  policy = (await page.goto(`${origin}/`))?.headers()['content-security-policy'];
  await page.fill('[name="operator-token"]', operatorToken);
  await page.dispatchEvent('[name="operator-token"]', 'change');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
});

afterAll(async () => {
  await browser?.close();
});

function lines(party: Party, list: 'holds' | 'messages'): Promise<string[]> {
  return page.$$eval(`[data-party="${party}"] .${list} li`, (items) => items.map((item) => item.textContent ?? ''));
}

// Where each box's messages stood when the beat began, so a check reads only the beat's own.
const marks = { a: 0, A: 0, B: 0, b: 0 };

async function beat(): Promise<void> {
  for (const party of PARTIES) marks[party] = (await lines(party, 'messages')).length;
}

async function fresh(party: Party): Promise<string[]> {
  return (await lines(party, 'messages')).slice(marks[party]);
}

/** Waits until the box's messages this beat include each needle. */
async function says(party: Party, ...needles: string[]): Promise<void> {
  await expect.poll(() => fresh(party), WAIT).toEqual(expect.arrayContaining(needles.map((needle) => expect.stringContaining(needle))));
}

/** Waits until what the box holds includes each needle. */
async function holds(party: Party, ...needles: string[]): Promise<void> {
  await expect.poll(() => lines(party, 'holds'), WAIT).toEqual(expect.arrayContaining(needles.map((needle) => expect.stringContaining(needle))));
}

/** Waits until what the box holds is exactly these lines, each a whole line or a pattern. */
async function holdsExactly(party: Party, expected: (string | RegExp)[]): Promise<void> {
  await expect.poll(() => lines(party, 'holds'), WAIT).toEqual(expected.map((line) => (typeof line === 'string' ? line : expect.stringMatching(line))));
}

// The box got no message this beat. Read at a beat's end, after its other checks have waited.
async function silent(party: Party): Promise<void> {
  expect(await fresh(party)).toEqual([]);
}

async function click(action: string): Promise<void> {
  await page.click(`[data-action="${action}"]`);
}

/** `a` writes a note, and its own box and A's both show the version. */
async function write(path: string, title: string): Promise<string> {
  await page.fill('[name="a-path"]', path);
  await page.fill('[name="a-title"]', title);
  const before = (await lines('a', 'messages')).length;
  await click('a-write');
  await expect.poll(async () => (await lines('a', 'messages')).length, WAIT).toBeGreaterThan(before);
  const said = (await lines('a', 'messages')).at(-1)!;
  expect(said).toContain(`write_note ${root}/${path} → `);
  const version = said.split(' → ')[1];
  await holds('a', `wrote ${root}/${path} at ${version}`);
  await holds('A', `note ${root}/${path} at ${version}`);
  return version;
}

/** `a` deletes a note, and its own box and A's both show the deletion. */
async function remove(path: string): Promise<string> {
  await page.fill('[name="a-path"]', path);
  const before = (await lines('a', 'messages')).length;
  await click('a-delete');
  await expect.poll(async () => (await lines('a', 'messages')).length, WAIT).toBeGreaterThan(before);
  const said = (await lines('a', 'messages')).at(-1)!;
  expect(said).toContain(`delete_note ${root}/${path} → `);
  const version = said.split(' → ')[1];
  await holds('a', `wrote ${root}/${path} at ${version}, deleted`);
  await holds('A', `note ${root}/${path} at ${version}, deleted`);
  return version;
}

async function clientId(party: 'a' | 'b'): Promise<string> {
  const line = (await lines(party, 'holds')).find((text) => text.startsWith('client '));
  return line?.slice('client '.length) ?? '';
}

// B answers an unsigned POST to b's hook 503 while b's socket is quiet, and 401 while it pings.
async function hookAnswers(status: number): Promise<void> {
  const hook = `${origin}/gateway/B/hooks/${await clientId('b')}`;
  await expect.poll(() => page.evaluate(async (url) => (await fetch(url, { method: 'POST', body: '{}' })).status, hook), { ...WAIT, interval: heartbeatMs }).toBe(status);
}

/** A's attempt reports this beat, as `[webhookId, attempt, outcome]`. */
async function attempts(): Promise<[string, number, string][]> {
  return (await fresh('A'))
    .filter((line) => line.startsWith('attempt '))
    .map((line) => JSON.parse(line.slice('attempt '.length)) as { webhookId: string; attempt: number; outcome: string })
    .map(({ webhookId, attempt, outcome }) => [webhookId, attempt, outcome]);
}

/** The webhook-id of the delivery `b` got this beat whose body names `needle`. */
async function deliveryId(needle: string): Promise<string> {
  await expect.poll(async () => (await fresh('b')).some((text) => text.startsWith('delivery ') && text.includes(needle)), WAIT).toBe(true);
  const line = (await fresh('b')).find((text) => text.startsWith('delivery ') && text.includes(needle))!;
  return line.split(' ')[1];
}

describe('the demo page', () => {
  it('walks beats 1 to 13, and each box shows what its party holds and the messages it saw', async () => {
    const note42 = 'notes/inbox/note-42';
    const uri42 = `${root}/${note42}`;
    const retryDelays = /^retry delays [\d, ]+ ms$/;
    const B_HOLDS = (client: string) => [`socket for ${client}`, `secret for ${client}: ${SECRET}`];

    // Beat 1, the cast: a and b signed in, b's socket open on B with its secret registered.
    await holds('b', 'socket open');
    const a1 = await clientId('a');
    const b1 = await clientId('b');
    await holdsExactly('a', [`client ${a1}`]);
    await holdsExactly('A', [retryDelays]);
    await holdsExactly('B', B_HOLDS(b1));
    await holdsExactly('b', [`client ${b1}`, 'socket open']);
    await says('A', 'hello ', 'http POST {"path":"/register","status":201', 'http GET {"path":"/authorize","status":302', 'http POST {"path":"/token","status":200', 'mcp tools/list');
    await says('B', 'hello ', `connected {"client":"${b1}"`, 'secret-registered ');
    await says('a', `signed in as ${a1}`);
    await says('b', `signed in as ${b1}`, 'socket open on B');
    await beat();

    // Beat 2, MCP core as it is: a writes, and b reads, with nothing naming a version.
    const v42 = await write(note42, 'Buy milk');
    await click('b-read');
    await says('b', `resources/read ${uri42} → `, 'Buy milk');
    expect((await fresh('b')).join('\n')).not.toContain('version');
    await says('A', 'mcp tools/call', 'mcp resources/read');
    await holdsExactly('a', [`client ${a1}`, `wrote ${uri42} at ${v42}`]);
    await holdsExactly('A', [`note ${uri42} at ${v42}`, retryDelays]);
    await holdsExactly('B', B_HOLDS(b1));
    await holdsExactly('b', [`client ${b1}`, 'socket open']);
    await silent('B');
    await beat();

    // Beat 3, plain HTTP: an ETag, and a conditional GET that answers 304, and A tells no one.
    await click('b-get');
    await says('b', `GET ${uri42} → 200 ETag "${v42}"`);
    await click('b-get-if-changed');
    await says('b', `If-None-Match "${v42}" → 304`);
    await says('A', `http GET {"path":"/server/A/${note42}","status":200`, `http GET {"path":"/server/A/${note42}","status":304`);
    await holdsExactly('A', [`note ${uri42} at ${v42}`, retryDelays]);
    await holdsExactly('b', [`client ${b1}`, 'socket open']);
    await silent('a');
    await silent('B');
    await beat();

    // Beat 4, mcp.resource.updated over Events: an occurrence reaches b through B.
    await click('b-subscribe-event');
    await says('b', 'events/subscribe → ');
    await holds('A', `to ${uri42}, until `);
    const v42b = await write(note42, 'Buy oat milk');
    const occurrence = await deliveryId('mcp.resource.updated');
    await says('A', 'mcp events/subscribe', 'verification ', '"outcome":"verified"', `"webhookId":"${occurrence}","attempt":1,"outcome":"200"`);
    await says('B', `"webhookId":"${occurrence}","signature":"verified","status":200`);
    await holdsExactly('B', B_HOLDS(b1));
    await holdsExactly('b', [`client ${b1}`, 'socket open', new RegExp(`^event subscription sub_\\w+ to ${uri42}$`)]);
    await holdsExactly('a', [`client ${a1}`, `wrote ${uri42} at ${v42b}`]);
    await beat();

    // Beat 5, the Wipe: all four start over, and A refuses every token from before it.
    const before = [...tokens];
    expect(before.length).toBeGreaterThan(0);
    await click('wipe');
    await expect.poll(() => page.textContent('[data-control-answer]'), WAIT).toBe('wipe: done, wipe: done');
    // The page cleared every box's messages as it showed the answer.
    marks.a = marks.A = marks.B = marks.b = 0;
    await says('b', 'registered again as ');
    // b's old socket closing can show b's holdings before it registers, so this waits for the new id.
    await expect.poll(async () => [b1, ''].includes(await clientId('b')), WAIT).toBe(false);
    const a2 = await clientId('a');
    const b2 = await clientId('b');
    expect(a2).not.toBe(a1);
    await says('a', `registered again as ${a2}`);
    await holdsExactly('a', [`client ${a2}`]);
    await holdsExactly('A', [retryDelays]);
    await holdsExactly('B', B_HOLDS(b2));
    await holdsExactly('b', [`client ${b2}`, 'socket open']);
    // B reports closing b's old socket for the Wipe, and no box shows anything else of before it.
    const wiped = `closed {"client":"${b1}","code":1012,"reason":"Wiped"}`;
    await says('B', wiped);
    for (const party of PARTIES) expect((await lines(party, 'messages')).filter((line) => (line.includes(b1) || line.includes(a1)) && line !== wiped)).toEqual([]);
    for (const authorization of before) {
      const status = await page.evaluate(
        async ([url, header]) =>
          (await fetch(url, { method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).status,
        [`${root}/mcp`, authorization],
      );
      expect(status).toBe(401);
    }
    await beat();

    // Beat 6, only the newest version matters: narration, and nothing moves. b pings through it on
    // B's heartbeat, so B still finds its socket alive after three heartbeats of quiet.
    await page.waitForTimeout(3 * heartbeatMs);
    for (const party of PARTIES) await silent(party);
    // B reports the probe's unsigned POST, which the next beat does not count.
    await hookAnswers(401);
    await beat();

    // Beat 7, a first subscription from nothing: one call subscribes and reads.
    const v1 = await write(note42, 'Buy milk');
    await page.fill('[name="b-path"]', note42);
    await click('b-subscribe');
    await says('b', `resources/webhooks/subscribe → `, `"version":"${v1}"`, 'Buy milk');
    await holdsExactly('b', [`client ${b2}`, 'socket open', new RegExp(`^subscription sub_\\w+ to ${uri42}$`), `${uri42} at ${v1} "Buy milk"`]);
    await says('A', 'mcp resources/webhooks/subscribe', '"outcome":"verified"');
    await holdsExactly('A', [`note ${uri42} at ${v1}`, new RegExp(`^subscription sub_\\w+ to ${uri42}, full, until `), retryDelays]);
    // A's handshake for the new subscription reaches B, which answers it for b.
    await says('B', '"webhookId":"msg_verification_', '"status":200');
    await holdsExactly('B', B_HOLDS(b2));
    await holdsExactly('a', [`client ${a2}`, `wrote ${uri42} at ${v1}`]);
    await beat();

    // Beat 8, a change it hears about, with its contents.
    const v2 = await write(note42, 'Buy oat milk');
    const change = await deliveryId(`"version":"${v2}"`);
    await holds('b', `${uri42} at ${v2} "Buy oat milk"`);
    await says('A', `"webhookId":"${change}","attempt":1,"outcome":"200"`);
    await says('B', `"webhookId":"${change}","signature":"verified","status":200`);
    await holdsExactly('B', B_HOLDS(b2));
    await beat();

    // Beat 9, a refresh: the subscriber's own call, which names what is current.
    await click('b-subscribe');
    await says('b', `"version":"${v2}"`, 'refreshBefore');
    await says('A', 'mcp resources/webhooks/subscribe');
    await holds('b', `${uri42} at ${v2} "Buy oat milk"`);
    await holds('A', `note ${uri42} at ${v2}`);
    await silent('B');
    await silent('a');
    await beat();

    // Beat 10, the laptop sleeps: with the demo's schedule set, v4 replaces the pending v3.
    await page.fill('[name="schedule"]', SCHEDULE.join(','));
    await click('schedule');
    await expect.poll(() => page.textContent('[data-control-answer]'), WAIT).toBe('schedule: done');
    await holds('A', `retry delays ${SCHEDULE.join(', ')} ms`);
    await click('b-sleep');
    await holds('b', 'socket open, asleep');
    await hookAnswers(503);
    await beat();
    const v3 = await write(note42, 'Buy oat milk and bread');
    await expect.poll(async () => (await attempts()).filter(([, , outcome]) => outcome === '503').length, WAIT).toBeGreaterThanOrEqual(1);
    const v4 = await write(note42, 'Buy oat milk, bread and eggs');
    await expect.poll(async () => new Set((await attempts()).map(([webhookId]) => webhookId)).size, WAIT).toBe(2);
    await click('b-wake');
    await holds('b', `${uri42} at ${v4} "Buy oat milk, bread and eggs"`, 'socket open');
    await says('B', '"status":503', '"status":200');
    const told = (await fresh('b')).join('\n');
    expect(told).toContain(`"version":"${v4}"`);
    expect(told).not.toContain(`"version":"${v3}"`);
    await holdsExactly('B', B_HOLDS(b2));
    await beat();

    // Beat 11, away past the retries: one refresh brings b to the current version.
    await click('b-sleep');
    await hookAnswers(503);
    await beat();
    const v5 = await write(note42, 'Buy oat milk and bread');
    await expect.poll(async () => (await attempts()).map(([, attempt, outcome]) => `${attempt} ${outcome}`), { ...WAIT, timeout: WAIT.timeout + SCHEDULE.reduce((sum, delay) => sum + delay, 0) }).toEqual(
      ['1 503', '2 503', '3 503', '4 503'],
    );
    await click('b-wake');
    await hookAnswers(401);
    await holds('b', `${uri42} at ${v4}`);
    await click('b-subscribe');
    await holds('b', `${uri42} at ${v5} "Buy oat milk and bread"`);
    await says('b', `"version":"${v5}"`);
    await holdsExactly('B', B_HOLDS(b2));
    await beat();

    // Beat 12, a deletion, in the notify form.
    const v6 = await remove(note42);
    const deletion = await deliveryId('"deleted":true');
    await holds('b', `${uri42} at ${v6}, deleted`);
    await says('B', `"webhookId":"${deletion}","signature":"verified","status":200`);
    await beat();

    // Beat 13, a folder from nothing, and catching it up after an absence.
    const inbox = `${root}/notes/inbox`;
    await page.fill('[name="b-path"]', 'notes/inbox');
    await click('b-subscribe');
    await says('b', '"changes":[]', '"cursor":');
    await holds('A', `to ${inbox}, full, until `);
    await holds('b', `to ${inbox}, cursor `);
    const n43v1 = await write('notes/inbox/note-43', 'Buy milk');
    await holds('b', `${inbox}/note-43 at ${n43v1} "Buy milk"`);
    await click('b-sleep');
    await hookAnswers(503);
    await beat();
    const n43v2 = await write('notes/inbox/note-43', 'Buy oat milk');
    const n43v3 = await write('notes/inbox/note-43', 'Buy oat milk, really');
    const n44v1 = await write('notes/inbox/note-44', 'Buy bread');
    const n43v4 = await remove('notes/inbox/note-43');
    // A gives up on note-43's deletion and on note-44, its last message for each.
    await expect.poll(async () => (await attempts()).filter(([, attempt]) => attempt === SCHEDULE.length + 1).length, { ...WAIT, timeout: WAIT.timeout + 4000 }).toBe(2);
    await click('b-wake');
    await hookAnswers(401);
    await beat();
    await click('b-subscribe');
    await holds('b', `${inbox}/note-43 at ${n43v4}, deleted`, `${inbox}/note-44 at ${n44v1} "Buy bread"`);
    const caughtUp = (await fresh('b')).join('\n');
    expect(caughtUp).toContain(`"version":"${n43v4}","deleted":true`);
    expect(caughtUp).not.toContain(n43v2);
    expect(caughtUp).not.toContain(n43v3);
    await says('A', 'mcp resources/webhooks/subscribe');
    await holdsExactly('B', B_HOLDS(b2));
    await silent('B');
    expect(errors).toEqual([]);
  });

  it('shows a title written as HTML as text, in every box and in what b holds, and runs nothing', async () => {
    const title = `<img src=x onerror="document.body.dataset.ran='yes'">`;
    const path = 'notes/archive/note-1';
    await write(path, 'Plain');
    await page.fill('[name="b-path"]', path);
    // b watches the note at both levels, so one write brings an occurrence and a change.
    await click('b-subscribe-event');
    await click('b-subscribe');
    await holds('b', `${root}/${path} at `, `event subscription sub_`);
    await beat();
    await write(path, title);
    await says('b', 'mcp.resource.updated', '<img src=x onerror=');
    await holds('b', `"${title}"`);
    await says('A', '<img src=x onerror=');
    expect(await page.$$('main img')).toHaveLength(0);
    // The policy stops an inline handler running even if one were parsed, which is the second guard.
    expect(policy).toContain("script-src 'self'");
    expect(await page.evaluate('document.body.dataset.ran')).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("reopens its back channels and b's socket when the Worker restarts, and b hears the next change", async () => {
    const path = 'notes/archive/note-1';
    await beat();
    // A restart of wrangler dev drops every socket, as a redeploy or a runtime reset would.
    expect((await fetch(inject('restartUrl'), { method: 'POST' })).status).toBe(204);
    await says('A', 'back channel closed');
    await says('B', 'back channel closed');
    await says('b', 'socket closed', 'socket open on B, secret registered', 'resources/webhooks/subscribe → ', 'events/subscribe → ');
    const b = await clientId('b');
    await holds('B', `socket for ${b}`);
    const version = await write(path, 'After the restart');
    await holds('b', `${root}/${path} at ${version} "After the restart"`);
    expect(errors).toEqual([]);
  });

  it("wakes b at a Wipe, since b's new socket pings from the start", async () => {
    await click('b-sleep');
    await holds('b', 'socket open, asleep');
    const asleep = await clientId('b');
    await click('wipe');
    await expect.poll(() => page.textContent('[data-control-answer]'), WAIT).toBe('wipe: done, wipe: done');
    marks.a = marks.A = marks.B = marks.b = 0;
    await says('b', 'registered again as ');
    await expect.poll(async () => [asleep, ''].includes(await clientId('b')), WAIT).toBe(false);
    const b = await clientId('b');
    await holdsExactly('b', [`client ${b}`, 'socket open']);
    await page.waitForTimeout(3 * heartbeatMs);
    await hookAnswers(401);
    expect(errors).toEqual([]);
  });

  it('keeps the operator token in sessionStorage, and sends it in no URL', async () => {
    expect(await page.evaluate("sessionStorage.getItem('operator-token')")).toBe(operatorToken);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => url.includes(operatorToken))).toEqual([]);
  });
});
