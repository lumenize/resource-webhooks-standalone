// The demo page in Chromium, where production serves it: the Worker's own origin over https. One
// narrative walks beats 1 to 13 of demo-script.md through the page's controls, and checks all
// four boxes after each beat, A's and B's as their back channels fed them.
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

let browser: Browser;
let page: Page;
// Every bearer token the page sent to A's MCP endpoint, so a test can try an old one, and every
// URL it asked for, none of which may carry the operator token.
const tokens = new Set<string>();
const urls: string[] = [];
let policy: string | undefined;

beforeAll(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await context.newPage();
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

async function silent(party: Party): Promise<void> {
  expect(await fresh(party)).toEqual([]);
}

async function click(action: string): Promise<void> {
  await page.click(`[data-action="${action}"]`);
}

async function write(path: string, title: string): Promise<string> {
  await page.fill('[name="a-path"]', path);
  await page.fill('[name="a-title"]', title);
  const before = (await lines('a', 'messages')).length;
  await click('a-write');
  await expect.poll(async () => (await lines('a', 'messages')).length, WAIT).toBeGreaterThan(before);
  const said = (await lines('a', 'messages')).at(-1)!;
  expect(said).toContain(`write_note ${root}/${path} → `);
  return said.split(' → ')[1];
}

async function remove(path: string): Promise<string> {
  await page.fill('[name="a-path"]', path);
  const before = (await lines('a', 'messages')).length;
  await click('a-delete');
  await expect.poll(async () => (await lines('a', 'messages')).length, WAIT).toBeGreaterThan(before);
  return (await lines('a', 'messages')).at(-1)!.split(' → ')[1];
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

describe('the demo page', () => {
  it('walks beats 1 to 13, and each box shows what its party holds and the messages it saw', async () => {
    const note42 = 'notes/inbox/note-42';
    const uri42 = `${root}/${note42}`;

    // Beat 1, the cast: a and b signed in, b's socket open on B with its secret registered.
    await holds('a', 'client ');
    await holds('b', 'client ', 'socket open');
    const b1 = await clientId('b');
    await holds('B', `socket for ${b1}`, `secret for ${b1}: whsec_…(32 bytes)`);
    await says('A', 'hello ', 'mcp tools/list');
    await says('B', 'hello ', 'connected ', 'secret-registered ');
    await says('b', `signed in as ${b1}`, 'socket open on B');
    await beat();

    // Beat 2, MCP core as it is: a writes, and b reads with nothing naming a version.
    const v42 = await write(note42, 'Buy milk');
    await holds('a', `wrote ${uri42} at ${v42}`);
    await click('b-read');
    await says('b', `resources/read ${uri42} → `, 'Buy milk');
    await holds('A', `note ${uri42} at ${v42}`);
    await says('A', 'mcp tools/call', 'mcp resources/read');
    await silent('B');
    await beat();

    // Beat 3, plain HTTP: an ETag, and a conditional GET that answers 304.
    await click('b-get');
    await says('b', `GET ${uri42} → 200 ETag "${v42}"`);
    await click('b-get-if-changed');
    await says('b', `If-None-Match "${v42}" → 304`);
    await silent('A');
    await silent('B');
    await silent('a');
    await beat();

    // Beat 4, mcp.resource.updated over Events: an occurrence reaches b through B.
    await click('b-subscribe-event');
    await says('b', 'events/subscribe → ');
    await holds('b', 'event subscription sub_');
    await write(note42, 'Buy oat milk');
    await says('A', 'mcp events/subscribe', 'verification ', '"outcome":"verified"', 'attempt ', '"outcome":"200"');
    await holds('A', `to ${uri42}`);
    await says('B', 'delivery ', '"signature":"verified"', '"status":200');
    await says('b', 'delivery msg_', 'mcp.resource.updated');
    await beat();

    // Beat 5, the Wipe: all four start over, and A refuses every token from before it.
    const before = [...tokens];
    expect(before.length).toBeGreaterThan(0);
    await click('wipe');
    await expect.poll(() => page.textContent('[data-control-answer]'), WAIT).toBe('wipe: done, wipe: done');
    // The page cleared every box as it showed the answer.
    marks.a = marks.A = marks.B = marks.b = 0;
    await says('b', 'registered again as ');
    // b's old socket closing can show b's holdings before it registers, so this waits for the new id.
    await expect.poll(() => clientId('b'), WAIT).not.toBe(b1);
    const b2 = await clientId('b');
    expect(b2).not.toBe('');
    await says('a', 'registered again as ');
    await holds('B', `socket for ${b2}`);
    expect(await lines('A', 'holds')).not.toEqual(expect.arrayContaining([expect.stringContaining('note ')]));
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
    await holds('b', `${uri42} at ${v1} "Buy milk"`);
    await says('A', 'mcp resources/webhooks/subscribe', '"outcome":"verified"');
    await holds('A', `to ${uri42}`, `note ${uri42} at ${v1}`);
    // A's handshake for the new subscription reaches B, which answers it for b.
    await says('B', '"webhookId":"msg_verification_', '"status":200');
    await beat();

    // Beat 8, a change it hears about, with its contents.
    const v2 = await write(note42, 'Buy oat milk');
    await holds('b', `${uri42} at ${v2} "Buy oat milk"`);
    await says('b', 'delivery msg_', `"version":"${v2}"`);
    await says('A', '"outcome":"200"');
    await says('B', '"status":200');
    await beat();

    // Beat 9, a refresh: the subscriber's own call, which names what is current.
    await click('b-subscribe');
    await says('b', `"version":"${v2}"`, 'refreshBefore');
    await says('A', 'mcp resources/webhooks/subscribe');
    await silent('B');
    await silent('a');
    await beat();

    // Beat 10, the laptop sleeps: with the demo's schedule set, v4 replaces the pending v3.
    await page.fill('[name="schedule"]', SCHEDULE.join(','));
    await click('schedule');
    await expect.poll(() => page.textContent('[data-control-answer]'), WAIT).toBe('schedule: done');
    await click('b-sleep');
    await holds('b', 'socket open, asleep');
    await hookAnswers(503);
    await beat();
    const v3 = await write(note42, 'Buy oat milk and bread');
    await expect.poll(async () => (await attempts()).filter(([, , outcome]) => outcome === '503').length, WAIT).toBeGreaterThanOrEqual(1);
    const v4 = await write(note42, 'Buy oat milk, bread and eggs');
    await expect.poll(async () => new Set((await attempts()).map(([webhookId]) => webhookId)).size, WAIT).toBe(2);
    await click('b-wake');
    await holds('b', `${uri42} at ${v4} "Buy oat milk, bread and eggs"`);
    await says('B', '"status":503', '"status":200');
    const told = (await fresh('b')).join('\n');
    expect(told).toContain(`"version":"${v4}"`);
    expect(told).not.toContain(`"version":"${v3}"`);
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
    await beat();

    // Beat 12, a deletion, in the notify form.
    const v6 = await remove(note42);
    await holds('b', `${uri42} at ${v6}, deleted`);
    await says('b', '"deleted":true');
    await holds('A', `note ${uri42} at ${v6}, deleted`);
    await says('B', '"status":200');
    await beat();

    // Beat 13, a folder from nothing, and catching it up after an absence.
    const inbox = `${root}/notes/inbox`;
    await page.fill('[name="b-path"]', 'notes/inbox');
    await click('b-subscribe');
    await says('b', '"changes":[]', '"cursor":');
    await holds('A', `to ${inbox},`);
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
    await silent('B');
  });

  it('shows a title written as HTML as text, and runs nothing', async () => {
    const title = `<img src=x onerror="document.body.dataset.ran='yes'">`;
    await beat();
    await write('notes/archive/note-1', title);
    await page.fill('[name="b-path"]', 'notes/archive/note-1');
    await click('b-read');
    await says('b', `resources/read ${root}/notes/archive/note-1 → `, '<img src=x onerror=');
    await says('A', '<img src=x onerror=');
    expect(await page.$$('main img')).toHaveLength(0);
    // Strings, since this file's types are the Worker's and have no DOM.
    expect(await page.evaluate('document.body.dataset.ran')).toBeUndefined();
    expect(policy).toContain("script-src 'self'");
  });

  it('keeps the operator token in sessionStorage, and sends it in no URL', async () => {
    expect(await page.evaluate("sessionStorage.getItem('operator-token')")).toBe(operatorToken);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => url.includes(operatorToken))).toEqual([]);
  });
});
