// Level 1 end to end: SEP-3415's Events for `mcp.resource.updated`, A's webhook deliveries, B and
// b's socket to it, and the page's controls. Real timers throughout: the lane's schedule, attempt
// timeout and heartbeat are fractions of a second. A test that needs a timestamp in seconds to
// move, or a grant to run out, moves the clock with vi.setSystemTime, which A sees too, since its
// objects share the test's globals.
import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it, vi } from 'vitest';
import { signToken } from '../../src/auth/signing';
import { McpError } from '../../src/client/mcp-client';
import { deliveryHeaders, newSecret, verify } from '../../src/standard-webhooks';
import { hookUrl, listen, signedIn, socketUrl, subscribe, watch, write, type Page } from '../client/parties';
import { scenario2 } from '../scenarios/level1';
import { callWorker, newLane, upgrade, type Lane } from './lane';
import { echo, receiver, type Received } from './receiver';

const CALLBACK_ENDPOINT_ERROR = -32027;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// The clock a moved one leaves alone, for measuring the schedule's real delays.
const realNow = Date.now.bind(Date);
const delays = env.RETRY_SCHEDULE_MS.split(',').map(Number);
const scheduleMs = delays.reduce((sum, delay) => sum + delay, 0);
// Every attempt the lane's schedule makes, as `[attempt, outcome]`.
const every = (outcome: string) => Array.from({ length: delays.length + 1 }, (_each, index): [number, string] => [index + 1, outcome]);

async function refusal(promise: Promise<unknown>): Promise<{ code: number; data?: unknown }> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(McpError);
  return { code: (error as McpError).code, data: (error as McpError).data };
}

/** POSTs a delivery to a client's hook on B, as A would, signed as the caller says. */
async function postToB(lane: Lane, clientId: string, body: string, headers: Record<string, string>): Promise<Response> {
  return callWorker(new Request(hookUrl(lane, clientId), { method: 'POST', headers, body }), lane.env);
}

function signedFor(secret: string, body: string, at = Math.floor(Date.now() / 1000), webhookId = `msg_${crypto.randomUUID().replaceAll('-', '')}`) {
  return deliveryHeaders(secret, webhookId, 'sub_0123456789abcdef', body, at);
}

/** A's reports of its delivery attempts, as `[attempt, outcome]`. */
function attempts(page: Page): [number, string][] {
  return page.reports().filter((report) => report.kind === 'attempt').map((report) => [report.attempt as number, report.outcome as string]);
}

/** Waits until B no longer holds a socket for the client, as after it closed its own. */
async function untilClosed(lane: Lane, clientId: string): Promise<void> {
  await vi.waitFor(async () => expect((await postToB(lane, clientId, '{}', {})).status).toBe(503));
}

/** Checks each captured delivery with the `standardwebhooks` package too, as well as B's verifier. */
function expectThePackageAccepts(secret: string, received: Received[]): void {
  expect(received.length).toBeGreaterThan(0);
  for (const each of received) expect(new Webhook(secret).verify(each.body, Object.fromEntries(each.headers))).toEqual(JSON.parse(each.body));
}

/** A gate a fake receiver awaits, so a test acts while A is waiting on it. */
function held() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
}

/** Runs `body` with a clock vi.setSystemTime can move, which otherwise keeps real time. */
async function withMovableClock<T>(body: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  try {
    return await body();
  } finally {
    vi.useRealTimers();
  }
}

const BODY = JSON.stringify({ eventId: 'evt_e0.1', name: 'mcp.resource.updated', timestamp: '2026-10-21T14:05:00Z', data: { uri: 'x' }, cursor: null });

describe('Scenario 2: mcp.resource.updated over Events', () => {
  it('lists the type, subscribes after the handshake, delivers an occurrence for a write, and reports it all redacted', () => scenario2(newLane()));
});

describe('B, the gateway', () => {
  it('passes on a fresh, verified delivery, and answers 401 to a body signed differently or a stale timestamp', async () => {
    const lane = newLane();
    const page = await watch(lane, 'B');
    const b = await signedIn(lane, 'b');
    const listener = await listen(lane, b);

    const otherBody = BODY.replace('"x"', '"y"');
    const planted = await signedFor(listener.secret, BODY, undefined, 'msg_<b>planted</b>');
    expect((await postToB(lane, b.clientId, otherBody, planted)).status).toBe(401);
    const sixMinutesAgo = Math.floor(Date.now() / 1000) - 6 * 60;
    expect((await postToB(lane, b.clientId, BODY, await signedFor(listener.secret, BODY, sixMinutesAgo))).status).toBe(401);
    expect((await postToB(lane, b.clientId, BODY, await signedFor(listener.secret, BODY))).status).toBe(200);
    await vi.waitFor(() => expect(listener.deliveries()).toHaveLength(1));
    expect(listener.deliveries()[0].body).toEqual(JSON.parse(BODY));

    // What an unverified POST carries never reaches the page, which anyone could otherwise write to.
    const reports = page.reports().filter((report) => report.kind === 'delivery');
    expect(reports.map(({ status, signature }) => [status, signature])).toEqual([
      [401, 'failed'],
      [401, 'stale'],
      [200, 'verified'],
    ]);
    expect(reports.slice(0, 2).every((report) => !('webhookId' in report) && !('client' in report))).toBe(true);
    expect(page.raw.join('\n')).not.toContain('planted');
    // A client id is URL-safe, so a malformed escape in the path names no client, and fails no parse.
    expect((await postToB(lane, '%E0%A4%A', BODY, await signedFor(listener.secret, BODY))).status).toBe(503);
  });

  it('refuses a secret that is not whsec_ and 24 to 64 bytes, saying so on the socket', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const url = socketUrl(lane, b.clientId);
    const response = await upgrade(lane.env, url, await b.session.tokenForResource(env.ORIGIN, url));
    const socket = response.webSocket!;
    socket.accept();
    const messages: unknown[] = [];
    socket.addEventListener('message', (event) => {
      messages.push(JSON.parse(event.data as string));
    });
    socket.send(JSON.stringify({ secret: `whsec_${btoa('x'.repeat(23))}` }));
    await vi.waitFor(() => expect(messages).toEqual([{ type: 'secret-refused' }]));
    expect((await postToB(lane, b.clientId, BODY, {})).status).toBe(503);
  });

  it("answers 503 while b's socket is closed, and A's retry delivers once b reconnects", async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/inbox/note-42`;
    const first = await listen(lane, b);
    await subscribe(b, uri, first.hookUrl, first.secret);
    // Got now, so the reconnect is quick enough to land inside the lane's 700 ms of retries.
    const token = await b.session.tokenForResource(env.ORIGIN, socketUrl(lane, b.clientId));
    first.close();
    await untilClosed(lane, b.clientId);

    await write(a, uri);
    await vi.waitFor(() => expect(attempts(page)).toEqual([[1, '503']]), { interval: 5 });
    const again = await listen(lane, b, { secret: first.secret, token });
    await vi.waitFor(() => expect(again.deliveries()).toHaveLength(1), { timeout: 3000 });
    const outcomes = attempts(page).map(([, outcome]) => outcome);
    expect(outcomes.at(-1)).toBe('200');
    expect(outcomes.slice(0, -1).every((outcome) => outcome === '503')).toBe(true);
  });

  it("answers 503 once b's last ping is two intervals old, with its socket still open", async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const listener = await listen(lane, b);
    await sleep(Number(env.HEARTBEAT_MS) * 1.2);
    listener.stopPinging();
    expect((await postToB(lane, b.clientId, BODY, await signedFor(listener.secret, BODY))).status).toBe(200);
    await sleep(Number(env.HEARTBEAT_MS) * 2.2);
    expect((await postToB(lane, b.clientId, BODY, await signedFor(listener.secret, BODY))).status).toBe(503);
    expect(listener.closes).toEqual([]);
  });

  it('closes the older socket on a reconnect, and uses the newest socket and its secret only', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const older = await listen(lane, b);
    const newer = await listen(lane, b);
    await vi.waitFor(() => expect(older.closes).toEqual([{ code: 4000, reason: 'Superseded by a newer connection' }]));

    expect((await postToB(lane, b.clientId, BODY, await signedFor(older.secret, BODY))).status).toBe(401);
    expect((await postToB(lane, b.clientId, BODY, await signedFor(newer.secret, BODY))).status).toBe(200);
    await vi.waitFor(() => expect(newer.deliveries()).toHaveLength(1));
    expect(older.deliveries()).toEqual([]);
  });

  it('closes a socket with 4401 when its token expires', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const url = socketUrl(lane, b.clientId);
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(env.TOKEN_SIGNING_KEY, { iss: env.ORIGIN, sub: b.clientId, aud: url, iat: now, exp: now + 2, epoch: 0 });
    const response = await upgrade(lane.env, url, token);
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const closes: number[] = [];
    socket.addEventListener('close', (event) => {
      closes.push(event.code);
    });
    await sleep(500);
    expect(closes).toEqual([]);
    await vi.waitFor(() => expect(closes).toEqual([4401]), { timeout: 4000 });
  });

  it('refuses an upgrade without a token for that very socket with 401, and one from another origin with 403, waking no Gateway', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    const woken: string[] = [];
    const recording = new Proxy(env.GATEWAY, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          woken.push(String(property));
          return (value as (...args: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const watched = { ...lane.env, GATEWAY: recording };
    const url = socketUrl(lane, b.clientId);
    const now = Math.floor(Date.now() / 1000);
    const mint = (aud: string, exp = now + 60) => signToken(env.TOKEN_SIGNING_KEY, { iss: env.ORIGIN, sub: b.clientId, aud, iat: now, exp, epoch: 0 });
    const own = await b.session.tokenForResource(env.ORIGIN, url);
    const expiring = await mint(url, now + 1);
    await sleep(1100);

    const malformed = socketUrl(lane, '%E0%A4%A');
    const refused: [string, string | undefined, string][] = [
      ['no token', undefined, url],
      ["b's token for A's MCP endpoint", await b.session.tokenFor(`${lane.root}/mcp`), url],
      ["b's token, on c's socket", own, socketUrl(lane, c.clientId)],
      ["a token for c's socket issued to b", await mint(socketUrl(lane, c.clientId)), socketUrl(lane, c.clientId)],
      ['an expired token', expiring, url],
      ['a token for a malformed path, on it', await mint(malformed), malformed],
    ];
    for (const [label, token, at] of refused) {
      expect({ label, status: (await upgrade(watched, at, token)).status }).toEqual({ label, status: 401 });
    }
    const withoutSubprotocol = await upgrade(watched, url, own, { 'Sec-WebSocket-Protocol': `rw.token.${own}` });
    expect(withoutSubprotocol.status).toBe(401);
    // Without a token, a 403 rather than a 401 shows the origin is refused before the hook runs.
    for (const token of [undefined, own]) {
      expect((await upgrade(watched, url, token, { Origin: 'https://evil.example' })).status).toBe(403);
    }
    expect(woken).toEqual([]);

    expect((await upgrade(watched, url, own)).status).toBe(101);
    expect(woken.length).toBeGreaterThan(0);
  });
});

describe("A's handshake", () => {
  it("subscribes only once B has acknowledged b's secret, and so passes on every run", async () => {
    for (let run = 0; run < 5; run++) {
      const lane = newLane();
      const b = await signedIn(lane, 'b');
      const listener = await listen(lane, b);
      const subscribed = await subscribe(b, `${lane.root}/notes/inbox/note-42`, listener.hookUrl, listener.secret);
      expect({ run, resultType: subscribed.resultType }).toEqual({ run, resultType: 'complete' });
    }
  });

  it('fails with challenge_failed for a secret B never registered, an altered echo, a reused nonce or an oversized answer, and subscribes nothing', async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    const uri = `${lane.root}/notes/inbox/note-42`;
    const failed = { code: CALLBACK_ENDPOINT_ERROR, data: { reason: 'challenge_failed' } };
    const challengeOf = (received: Received) => (JSON.parse(received.body) as { challenge: string }).challenge;

    const listener = await listen(lane, b);
    expect(await refusal(subscribe(b, uri, listener.hookUrl, newSecret()))).toEqual(failed);

    const altered = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: (received) => {
        const challenge = challengeOf(received);
        return Response.json({ challenge: `${challenge.slice(0, -1)}${challenge.endsWith('A') ? 'B' : 'A'}` });
      },
    });
    expect(await refusal(subscribe(b, uri, altered.url(), newSecret()))).toEqual(failed);

    // A's answer is read up to 4 KiB, since anyone can name the URL that gives it.
    const oversized = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: (received) => Response.json({ challenge: challengeOf(received), padding: 'x'.repeat(8192) }),
    });
    expect(await refusal(subscribe(b, uri, oversized.url(), newSecret()))).toEqual(failed);

    let firstNonce: string | undefined;
    const replaying = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: (received) => {
        firstNonce ??= challengeOf(received);
        return Response.json({ challenge: firstNonce });
      },
    });
    expect((await subscribe(b, uri, replaying.url(), newSecret())).resultType).toBe('complete');
    expect(await refusal(subscribe(c, uri, replaying.url(), newSecret()))).toEqual(failed);
    expect(replaying.challenges()).toHaveLength(2);

    // Only b's subscription at the replaying receiver holds, so a write reaches it alone.
    await write(a, uri);
    await vi.waitFor(() => expect(replaying.deliveries()).toHaveLength(1));
    await sleep(100);
    expect(page.reports().filter((report) => report.kind === 'attempt').map((report) => report.url)).toEqual([replaying.url()]);
    expect([altered, oversized].map((each) => each.deliveries().length)).toEqual([0, 0]);
  });

  it('writes the subscription only once its handshake succeeds, so a write during the handshake is not delivered', async () => {
    const lane = newLane();
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/inbox/note-42`;
    const hold = held();
    const endpoint = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: async (received, index) => {
        await hold.gate;
        return echo(received, index);
      },
    });
    const pending = subscribe(b, uri, endpoint.url(), newSecret());
    await vi.waitFor(() => expect(endpoint.challenges()).toHaveLength(1));
    await write(a, uri, 'During the handshake');
    await sleep(100);
    expect(endpoint.deliveries()).toEqual([]);

    hold.release();
    expect((await pending).resultType).toBe('complete');
    await sleep(100);
    expect(endpoint.deliveries()).toEqual([]);
    await write(a, uri, 'After it');
    await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(1));
  });

  it('writes nothing for a subscribe whose handshake a Wipe outlasted', async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/inbox/note-42`;
    const hold = held();
    const endpoint = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: async (received, index) => {
        await hold.gate;
        return echo(received, index);
      },
    });
    const pending = subscribe(b, uri, endpoint.url(), newSecret());
    await vi.waitFor(() => expect(endpoint.challenges()).toHaveLength(1));
    expect((await page.control('wipe')).type).toBe('done');
    hold.release();
    expect(await refusal(pending)).toEqual({ code: -32024 });

    await write(await signedIn(lane, 'a after the Wipe'), uri);
    await sleep(100);
    expect(endpoint.deliveries()).toEqual([]);
  });

  it('caches a handshake per principal and URL, in memory, until a grant would have run out', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const note = (n: number) => `${lane.root}/notes/inbox/note-${n}`;

    await subscribe(b, note(1), endpoint.url(), newSecret());
    await subscribe(b, note(2), endpoint.url(), newSecret());
    expect(endpoint.challenges()).toHaveLength(1);
    await subscribe(c, note(1), endpoint.url(), newSecret());
    expect(endpoint.challenges()).toHaveLength(2);
    await evictDurableObject(lane.stub);
    await subscribe(b, note(3), endpoint.url(), newSecret());
    expect(endpoint.challenges()).toHaveLength(3);

    await withMovableClock(async () => {
      await subscribe(b, note(3), endpoint.url(), newSecret());
      expect(endpoint.challenges()).toHaveLength(3);
      vi.setSystemTime(Date.now() + Number(env.SUBSCRIPTION_TTL_MS) + 1000);
      await subscribe(b, note(3), endpoint.url(), newSecret());
      expect(endpoint.challenges()).toHaveLength(4);
    });
  });

  it('refuses a verification POST past the burst for one host with ResourceExhausted', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const uri = `${lane.root}/notes/inbox/note-42`;
    const burst = Number(env.VERIFICATION_BURST);
    // Two principals, since one may hold only SUBSCRIPTION_CAP subscriptions.
    for (let n = 0; n < burst; n++) {
      await subscribe(n % 2 ? c : b, uri, endpoint.url(`/hook/${n}`), newSecret());
    }
    expect(await refusal(subscribe(c, uri, endpoint.url('/hook/next'), newSecret()))).toEqual({ code: -32025, data: { limit: 'verifications' } });
    expect(endpoint.challenges()).toHaveLength(burst);
    const elsewhere = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    expect((await subscribe(c, uri, elsewhere.url(), newSecret())).resultType).toBe('complete');
  });

  it('refuses a subscription past the cap per principal with ResourceExhausted, and lets one already held refresh', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const c = await signedIn(lane, 'c');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const note = (n: number) => `${lane.root}/notes/inbox/note-${n}`;
    const cap = Number(env.SUBSCRIPTION_CAP);
    for (let n = 0; n < cap; n++) await subscribe(b, note(n), endpoint.url(), newSecret());
    expect(await refusal(subscribe(b, note(cap), endpoint.url(), newSecret()))).toEqual({ code: -32025, data: { limit: 'subscriptions', max: cap } });
    expect((await subscribe(b, note(0), endpoint.url(), newSecret())).resultType).toBe('complete');
    expect((await subscribe(c, note(cap), endpoint.url(), newSecret())).resultType).toBe('complete');
  });

  it('holds the cap when two subscribes wait on their handshakes at once', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const note = (n: number) => `${lane.root}/notes/inbox/note-${n}`;
    const cap = Number(env.SUBSCRIPTION_CAP);
    for (let n = 0; n < cap - 1; n++) await subscribe(b, note(n), endpoint.url(), newSecret());
    const hold = held();
    const slow = receiver({
      deliveries: () => new Response(null, { status: 200 }),
      challenges: async (received, index) => {
        await hold.gate;
        return echo(received, index);
      },
    });
    const both = [subscribe(b, note(cap), slow.url('/one'), newSecret()), subscribe(b, note(cap + 1), slow.url('/two'), newSecret())];
    await vi.waitFor(() => expect(slow.challenges()).toHaveLength(2));
    hold.release();
    const outcomes = await Promise.all(both.map((each) => each.then(() => 'complete', (error: McpError) => error.code)));
    expect(outcomes.filter((outcome) => outcome === 'complete')).toHaveLength(1);
    expect(outcomes).toContain(-32025);
  });

  it('refuses a delivery URL that is not https, and a secret that is not whsec_ and 24 to 64 bytes, with InvalidParams', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const endpoint = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const uri = `${lane.root}/notes/inbox/note-42`;
    const ofBytes = (bytes: number) => `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))}`;
    const refused: [string, string, string][] = [
      ['http', endpoint.url().replace('https:', 'http:'), newSecret()],
      ['23 bytes', endpoint.url(), ofBytes(23)],
      ['65 bytes', endpoint.url(), ofBytes(65)],
      ['wrong prefix', endpoint.url(), ofBytes(32).replace('whsec_', 'whsk_')],
    ];
    for (const [label, url, secret] of refused) {
      expect({ label, ...(await refusal(subscribe(b, uri, url, secret))) }).toMatchObject({ label, code: -32602 });
    }
    expect(endpoint.challenges()).toHaveLength(0);
    for (const bytes of [24, 64]) expect((await subscribe(b, uri, endpoint.url(`/hook/${bytes}`), ofBytes(bytes))).resultType).toBe('complete');
  });

  it("refuses an events request whose Mcp-Name is missing or is not the event's name, with HeaderMismatch", async () => {
    const lane = newLane();
    const params = {
      name: 'mcp.resource.updated',
      arguments: { uri: `${lane.root}/notes/inbox/note-42` },
      delivery: { mode: 'webhook', url: 'https://receiver.invalid/hook', secret: newSecret() },
      cursor: null,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
    };
    for (const name of [undefined, 'another.type']) {
      const response = await lane.fetch('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await lane.token()}`,
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'events/subscribe',
          ...(name === undefined ? {} : { 'Mcp-Name': name }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params }),
      });
      expect({ name, status: response.status, code: ((await response.json()) as { error: { code: number } }).error.code }).toEqual({ name, status: 400, code: -32020 });
    }
  });
});

describe("A's deliveries", () => {
  async function subscribedTo(answer: Parameters<typeof receiver>[0]['deliveries']) {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/inbox/note-42`;
    const endpoint = receiver({ deliveries: answer });
    const secret = newSecret();
    await subscribe(b, uri, endpoint.url(), secret);
    return { lane, page, a, b, uri, endpoint, secret };
  }

  it('retries a 401 on the schedule, each attempt freshly signed, and sends nothing after the last', async () => {
    await withMovableClock(async () => {
      // Each answer moves the clock two seconds, so each attempt's timestamp, in seconds, is new.
      const at: number[] = [];
      const { a, uri, endpoint, secret } = await subscribedTo(() => {
        at.push(realNow());
        vi.setSystemTime(Date.now() + 2000);
        return new Response('Unauthorized', { status: 401 });
      });
      await write(a, uri);
      await vi.waitFor(() => expect(endpoint.deliveries()).toHaveLength(delays.length + 1), { timeout: 3000 });
      const sent = endpoint.deliveries();
      expect(new Set(sent.map((each) => each.headers.get('webhook-id'))).size).toBe(1);
      expect(new Set(sent.map((each) => each.headers.get('webhook-timestamp'))).size).toBe(sent.length);
      for (const each of sent) {
        const timestamp = Number(each.headers.get('webhook-timestamp'));
        expect(await verify([secret], each.headers, new TextEncoder().encode(each.body), timestamp)).toBe('verified');
      }
      expectThePackageAccepts(secret, sent);
      for (const [index, delay] of delays.entries()) expect(at[index + 1] - at[index]).toBeGreaterThanOrEqual(delay - 5);
      await sleep(scheduleMs);
      expect(endpoint.deliveries()).toHaveLength(delays.length + 1);
    });
  });

  it('fails an attempt answered with 302, and never fetches its Location', async () => {
    const elsewhere = receiver({ deliveries: () => new Response(null, { status: 200 }) });
    const { page, a, uri, endpoint, secret } = await subscribedTo(() => new Response(null, { status: 302, headers: { Location: elsewhere.url('/taken') } }));
    await write(a, uri);
    await vi.waitFor(() => expect(attempts(page)).toEqual(every('302')), { timeout: 3000 });
    expect(endpoint.deliveries()).toHaveLength(delays.length + 1);
    expectThePackageAccepts(secret, endpoint.deliveries());
    expect(elsewhere.received).toEqual([]);
  });

  it('stops retrying a delivery answered with 410 or 413, and retries one answered with 500', async () => {
    const outcomes = await Promise.all(
      [410, 413, 500].map(async (status) => {
        const { a, uri, endpoint, secret } = await subscribedTo(() => new Response(null, { status }));
        await write(a, uri);
        return { status, endpoint, secret };
      }),
    );
    await sleep(scheduleMs + 500);
    expect(outcomes.map(({ status, endpoint }) => [status, endpoint.deliveries().length])).toEqual([
      [410, 1],
      [413, 1],
      [500, delays.length + 1],
    ]);
    for (const { endpoint, secret } of outcomes) expectThePackageAccepts(secret, endpoint.deliveries());
  });

  it('retries a receiver that hangs once the attempt times out', async () => {
    const { page, a, uri, endpoint, secret } = await subscribedTo((_received, index) => (index === 0 ? new Promise<Response>(() => {}) : new Response(null, { status: 200 })));
    await write(a, uri);
    await vi.waitFor(() => expect(attempts(page)).toEqual([[1, 'timeout'], [2, '200']]), { timeout: 3000 });
    expect(endpoint.deliveries()).toHaveLength(2);
    expectThePackageAccepts(secret, endpoint.deliveries());
  });

  it('answers a refresh after an absence with cursor null, and replays nothing missed', async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/inbox/note-42`;
    const first = await listen(lane, b);
    const subscribed = await subscribe(b, uri, first.hookUrl, first.secret);
    first.close();
    await untilClosed(lane, b.clientId);
    await write(a, uri, 'Missed');
    await vi.waitFor(() => expect(attempts(page)).toEqual(every('503')), { timeout: 3000 });

    const again = await listen(lane, b, { secret: first.secret });
    const refreshed = await subscribe(b, uri, again.hookUrl, again.secret);
    expect(refreshed).toMatchObject({ id: subscribed.id, cursor: null });
    await sleep(scheduleMs);
    expect(again.deliveries()).toEqual([]);
    await write(a, uri, 'Seen');
    await vi.waitFor(() => expect(again.deliveries()).toHaveLength(1));
  });

  it('stops delivering once unsubscribed by the key, and answers NotFound for an unknown subscription or event type', async () => {
    const lane = newLane();
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/inbox/note-42`;
    const listener = await listen(lane, b);
    await subscribe(b, uri, listener.hookUrl, listener.secret);
    await write(a, uri, 'Heard');
    await vi.waitFor(() => expect(listener.deliveries()).toHaveLength(1));

    const key = { name: 'mcp.resource.updated', arguments: { uri }, delivery: { url: listener.hookUrl } };
    expect(await b.client.request('events/unsubscribe', key)).toMatchObject({ resultType: 'complete' });
    await write(a, uri, 'Unheard');
    await sleep(scheduleMs);
    expect(listener.deliveries()).toHaveLength(1);
    expect(await refusal(b.client.request('events/unsubscribe', key))).toEqual({ code: -32023, data: { kind: 'subscription' } });
    expect(await refusal(subscribe(b, uri, listener.hookUrl, listener.secret, { name: 'no.such.type' }))).toEqual({ code: -32023, data: { kind: 'event' } });
  });

  it('drops the retries of a delivery pending at the unsubscribe, as SEP-3415 asks', async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/inbox/note-42`;
    const first = await listen(lane, b);
    await subscribe(b, uri, first.hookUrl, first.secret);
    first.close();
    await untilClosed(lane, b.clientId);
    await write(a, uri, 'Pending');
    await vi.waitFor(() => expect(attempts(page)).toEqual([[1, '503']]), { interval: 5 });

    await b.client.request('events/unsubscribe', { name: 'mcp.resource.updated', arguments: { uri }, delivery: { url: first.hookUrl } });
    // An attempt already in flight still reports, but none follows it.
    await sleep(50);
    const atUnsubscribe = attempts(page).length;
    const again = await listen(lane, b, { secret: first.secret });
    await sleep(scheduleMs);
    expect(again.deliveries()).toEqual([]);
    expect(attempts(page)).toHaveLength(atUnsubscribe);
  });

  it('answers events/poll and events/stream with Unsupported, naming deliveryMode', async () => {
    const lane = newLane();
    const b = await signedIn(lane, 'b');
    const params = { name: 'mcp.resource.updated', arguments: { uri: `${lane.root}/notes/inbox/note-42` }, cursor: null };
    for (const method of ['events/poll', 'events/stream']) {
      expect({ method, ...(await refusal(b.client.request(method, params))) }).toEqual({ method, code: -32026, data: { feature: 'deliveryMode' } });
    }
  });
});

describe("The page's controls", () => {
  it('greets each page with the version of the code its object runs', async () => {
    expect(env.VERSION.id).toMatch(/^[0-9a-f-]{8,}$/);
    const lane = newLane();
    for (const party of ['A', 'B'] as const) {
      const page = await watch(lane, party);
      await vi.waitFor(() => expect(page.raw.length).toBeGreaterThan(0));
      expect(JSON.parse(page.raw[0])).toEqual({ party, kind: 'hello', version: env.VERSION.id });
    }
  });

  it('refuses a control with the wrong operator token, and names one it does not know, on A and on B', async () => {
    const lane = newLane();
    for (const party of ['A', 'B'] as const) {
      const page = await watch(lane, party);
      expect(await page.control('wipe', {}, 'not-the-operator-token')).toEqual({ type: 'refused', action: 'wipe' });
      expect(await page.control('wipe', {}, null)).toEqual({ type: 'refused', action: 'wipe' });
      expect(await page.control('nonsense')).toEqual({ type: 'unknown', action: 'nonsense' });
    }
  });

  it("closes every client's socket on B's Wipe", async () => {
    const lane = newLane();
    const page = await watch(lane, 'B');
    const b = await signedIn(lane, 'b');
    const listener = await listen(lane, b);
    expect(await page.control('wipe')).toEqual({ type: 'done', action: 'wipe' });
    await vi.waitFor(() => expect(listener.closes).toEqual([{ code: 1012, reason: 'Wiped' }]));
    expect((await postToB(lane, b.clientId, BODY, await signedFor(listener.secret, BODY))).status).toBe(503);
  });

  it("raises the epoch at each of A's Wipes, mints versions unlike any before, and drops a retry pending at the Wipe", async () => {
    const lane = newLane();
    const page = await watch(lane, 'A');
    const a = await signedIn(lane, 'a');
    const b = await signedIn(lane, 'b');
    const uri = `${lane.root}/notes/inbox/note-42`;
    const before = [await write(a, uri, 'One'), await write(a, uri, 'Two')];
    const listener = await listen(lane, b);
    await subscribe(b, uri, listener.hookUrl, listener.secret);
    const socketToken = await b.session.tokenForResource(env.ORIGIN, socketUrl(lane, b.clientId));
    listener.close();
    await untilClosed(lane, b.clientId);
    before.push(await write(a, uri, 'Pending'));
    await vi.waitFor(() => expect(attempts(page)).toEqual([[1, '503']]), { interval: 5 });

    const first = await page.control('wipe');
    const second = await page.control('wipe');
    expect(first).toEqual({ type: 'done', action: 'wipe', epoch: expect.any(Number) });
    expect(second.epoch).toBe((first.epoch as number) + 1);
    // An attempt already in flight still reports, but none follows it.
    await sleep(50);
    const atWipe = attempts(page).length;

    // b's old token for its socket still opens one, so the dropped retry had somewhere to go.
    const again = await listen(lane, b, { secret: listener.secret, token: socketToken });
    const after = await write(await signedIn(lane, 'a again'), uri, 'After');
    expect(before).not.toContain(after);
    await sleep(scheduleMs + 200);
    expect(again.deliveries()).toEqual([]);
    expect(attempts(page)).toHaveLength(atWipe);
  });
});
