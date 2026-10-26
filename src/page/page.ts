// The demo page: four boxes, for the writer `a`, the server A, the gateway B and the client `b`.
// `a` and `b` run here, on the same client modules the tests use, so their boxes are their own
// records. A and B run on Cloudflare and report to the page over a back channel each: every
// message they send and receive, and what they hold after each change. Every value is shown as
// text, never parsed as HTML. The operator token is typed in and kept in sessionStorage, and
// never goes in a URL. The page's staging beyond the mechanics waits for rehearsal.
import { Copies } from '../client/copies.js';
import { createMcpClient, OAuthError, OAuthSession, type McpClient } from '../client/mcp-client.js';
import type { ResourceChange, ResourceWebhookSubscribeResult } from '../resource-webhooks-types.js';
import { newSecret } from '../standard-webhooks.js';

type Party = 'a' | 'A' | 'B' | 'b';
type Message = Record<string, unknown>;

const ORIGIN = location.origin;
const SERVER = 'A';
const GATEWAY = 'B';
const ROOT = `${ORIGIN}/server/${SERVER}`;
const OPERATOR_TOKEN_KEY = 'operator-token';
// How long a control waits for its answer, and the longest wait before a back channel reconnects.
const ANSWER_MS = 10_000;
const RECONNECT_MAX_MS = 10_000;

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`The page has no ${selector}`);
  return found;
}

function input(name: string): HTMLInputElement {
  return element<HTMLInputElement>(`[name="${name}"]`);
}

// Each box's two lists: what its party holds, and the messages it sent and received.
function say(party: Party, text: string): void {
  const item = document.createElement('li');
  item.textContent = text;
  element(`[data-party="${party}"] .messages`).append(item);
}

function hold(party: Party, lines: string[]): void {
  element(`[data-party="${party}"] .holds`).replaceChildren(
    ...lines.map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }),
  );
}

// A and B report every message whole, so a box shows the start of each. A client's own results
// are shown at greater length, since a catch-up's changes are what a beat is about.
function short(value: unknown, limit = 400): string {
  const text = JSON.stringify(value) ?? '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const LONG = 2000;

// A and B: their reports, and what each says it holds.

interface Holdings {
  notes?: { uri: string; version: string; deleted: boolean }[];
  subscriptions?: { id: string; targetKind: string; target: string; form: string | null; expiresAt: string }[];
  schedule?: number[];
  sockets?: { client: string; connectedAt: string; secret?: string }[];
}

function showHoldings(party: 'A' | 'B', holdings: Holdings): void {
  if (party === 'A') {
    hold('A', [
      ...(holdings.notes ?? []).map(({ uri, version, deleted }) => `note ${uri} at ${version}${deleted ? ', deleted' : ''}`),
      ...(holdings.subscriptions ?? []).map(({ id, targetKind, target, form, expiresAt }) => `subscription ${id} to ${targetKind === 'listed' ? 'listed' : target}${form ? `, ${form}` : ''}, until ${expiresAt}`),
      `retry delays ${(holdings.schedule ?? []).join(', ')} ms`,
    ]);
  } else {
    hold('B', (holdings.sockets ?? []).flatMap(({ client, secret }) => [`socket for ${client}`, ...(secret ? [`secret for ${client}: ${secret}`] : [])]));
  }
}

function describe(report: Message): string {
  const { party: _party, kind, method, ...rest } = report;
  return `${kind}${method ? ` ${method}` : ''} ${short(rest)}`;
}

interface BackChannel {
  control(action: string, extra?: Message): Promise<Message>;
}

/** A back channel that reconnects when it drops, as a redeploy or a runtime reset drops it. */
function backChannel(party: 'A' | 'B'): BackChannel {
  const path = party === 'A' ? `/server/${SERVER}/page` : `/gateway/${GATEWAY}/page`;
  const answers = new Map<string, (message: Message) => void>();
  let socket: WebSocket;
  let delay = 500;
  const connect = () => {
    socket = new WebSocket(`${ORIGIN.replace(/^http/, 'ws')}${path}`);
    socket.addEventListener('open', () => (delay = 500));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data as string) as Message;
      if (message.party !== party) {
        // An answer to a control, which the page shows in the header and never in a box.
        answers.get(message.action as string)?.(message);
        return;
      }
      if (message.kind === 'holdings') return showHoldings(party, message as Holdings);
      say(party, describe(message));
    });
    socket.addEventListener('close', () => {
      for (const answer of [...answers.values()]) answer({ type: 'closed' });
      say(party, `back channel closed, reconnecting in ${delay} ms`);
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    });
  };
  connect();
  return {
    async control(action, extra = {}) {
      if (socket.readyState === WebSocket.CONNECTING) await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
      if (socket.readyState !== WebSocket.OPEN) return { type: 'closed', action };
      const operatorToken = sessionStorage.getItem(OPERATOR_TOKEN_KEY) ?? '';
      const answer = new Promise<Message>((resolve) => {
        const settle = (message: Message) => {
          clearTimeout(timer);
          answers.delete(action);
          resolve({ ...message, action });
        };
        const timer = setTimeout(() => settle({ type: 'no answer' }), ANSWER_MS);
        answers.set(action, settle);
      });
      socket.send(JSON.stringify({ type: 'control', operatorToken, action, ...extra }));
      return answer;
    },
  };
}

// `a` and `b`: clients of A, each signed in through A's authorization server.

/**
 * Runs the authorization code flow's front half in a hidden frame, since a page's fetch cannot
 * read a redirect. A consents at once and sends the frame back to `/callback`, a page of the
 * same origin, whose URL carries the code. An error A answers instead, as `invalid_client` for a
 * client a Wipe made it forget, is read off the frame and thrown as the session's own error, so
 * the session registers again.
 */
function authorizeInFrame(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    const timer = setTimeout(() => {
      frame.remove();
      reject(new Error('Sign-in did not come back'));
    }, 15_000);
    frame.addEventListener('load', () => {
      const href = frame.contentWindow?.location.href ?? '';
      const text = frame.contentDocument?.body?.innerText ?? '';
      clearTimeout(timer);
      frame.remove();
      if (href.startsWith(`${ORIGIN}/callback`)) return resolve(href);
      let code: string | undefined;
      try {
        code = (JSON.parse(text) as { error?: string }).error;
      } catch {
        code = undefined;
      }
      reject(new OAuthError(`The authorization endpoint answered without a redirect: ${text}`, code));
    });
    frame.src = url;
    document.body.append(frame);
  });
}

interface Client {
  session: OAuthSession;
  mcp: McpClient;
  clientId(): string;
}

function client(name: 'a' | 'b'): Client {
  // A private field's call passes the session as `this`, which the browser's fetch refuses.
  const send = (resource: RequestInfo | URL, init?: RequestInit) => fetch(resource, init);
  const session = new OAuthSession({ redirectUri: `${ORIGIN}/callback`, clientName: name, authorize: authorizeInFrame, fetch: send });
  const mcp = createMcpClient({ endpoint: `${ROOT}/mcp`, clientInfo: { name, version: '0.0.0' }, oauth: session, fetch: send });
  return { session, mcp, clientId: () => session.clientIdFor(ORIGIN) ?? '(not signed in)' };
}

async function signIn(party: 'a' | 'b', who: Client): Promise<void> {
  const before = who.session.clientIdFor(ORIGIN);
  // A token A refuses, as after a Wipe, sends the session back to register again.
  await who.mcp.request('tools/list');
  const now = who.clientId();
  say(party, before && before !== now ? `registered again as ${now}` : `signed in as ${now}`);
}

// `a`'s notes, as it wrote them.
const written = new Map<string, string>();

function showWriter(): void {
  hold('a', [`client ${a.clientId()}`, ...[...written].map(([uri, version]) => `wrote ${uri} at ${version}`)]);
}

// `b`'s socket on B, its copies, and the subscriptions it made at each level.

interface Listener {
  hookUrl: string;
  secret: string;
  sleep(): void;
  wake(): void;
  close(): void;
}

let copies = newCopies();
// Each level 1 subscription's id, with the URI it watches, so a reconnect can subscribe again.
const eventSubscriptions = new Map<string, string>();
const etags = new Map<string, string>();
const seen = new Set<string>();
let listener: Listener | undefined;
let asleep = false;

function newCopies(): Copies {
  return new Copies(async (target, { version, cursor }) => {
    const hook = await listening();
    const result = await b.mcp.request<ResourceWebhookSubscribeResult>('resources/webhooks/subscribe', {
      ...target,
      delivery: { url: hook.hookUrl, secret: hook.secret },
      form: 'full',
      catchUp: 'full',
      ttlMs: 3_600_000,
      ...(version ? { version } : {}),
      ...(cursor ? { cursor } : {}),
    });
    say('b', `resources/webhooks/subscribe → ${short(result, LONG)}`);
    for (const change of result.changes ?? []) seen.add(change.uri);
    return result;
  });
}

function titleOf(uri: string): string {
  const text = copies.get(uri)?.contents?.[0];
  if (!text || !('text' in text)) return '';
  try {
    return ` "${(JSON.parse(text.text) as { title?: string }).title ?? ''}"`;
  } catch {
    return '';
  }
}

function showClient(): void {
  const lines = [`client ${b.clientId()}`, listener ? `socket open${asleep ? ', asleep' : ''}` : 'no socket'];
  for (const [id, uri] of eventSubscriptions) lines.push(`event subscription ${id} to ${uri}`);
  for (const { target, id, cursor } of copies.subscriptions()) lines.push(`subscription ${id ?? '(waiting)'} to ${Object.values(target)[0]}${cursor ? `, cursor ${cursor}` : ''}`);
  for (const uri of [...seen].sort()) {
    const copy = copies.get(uri);
    if (copy) lines.push(`${uri} at ${copy.version}${copy.deleted ? ', deleted' : titleOf(uri)}`);
  }
  hold('b', lines);
}

/** b's socket, opened first if it is not. */
async function listening(): Promise<Listener> {
  listener ??= await listen();
  return listener;
}

async function listen(): Promise<Listener> {
  const url = `${ORIGIN}/gateway/${GATEWAY}/ws/${b.clientId()}`;
  const token = await b.session.tokenForResource(ORIGIN, url);
  const socket = new WebSocket(url.replace(/^http/, 'ws'), ['rw.1', `rw.token.${token}`]);
  const secret = newSecret();
  let pinging: ReturnType<typeof setInterval> | undefined;
  let heartbeatMs: number | undefined;
  const ping = () => {
    clearInterval(pinging);
    if (heartbeatMs) pinging = setInterval(() => socket.send('ping'), heartbeatMs);
  };
  let closedByPage = false;
  const close = () => {
    closedByPage = true;
    socket.close(1000, 'Done');
  };
  const registered = new Promise<void>((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      if (event.data === 'pong') return;
      const message = JSON.parse(event.data as string) as Message;
      if (message.type === 'secret-registered') {
        // B says how often to ping, since it counts a socket quiet for two heartbeats as asleep.
        heartbeatMs = message.heartbeatMs as number;
        if (!asleep) ping();
        return resolve();
      }
      if (message.type === 'secret-refused') return reject(new Error('B refused the secret'));
      if (message.type !== 'delivery') return;
      const body = JSON.parse(message.body as string) as Message;
      const subscriptionId = message.subscriptionId as string;
      say('b', `delivery ${message.webhookId as string} → ${short(body, LONG)}`);
      // A level 1 occurrence is news to show, and a level 2 change is a copy to take.
      if (!eventSubscriptions.has(subscriptionId)) {
        seen.add(body.uri as string);
        copies.deliver(body as unknown as ResourceChange, { webhookId: message.webhookId as string, subscriptionId });
      }
      showClient();
    });
    socket.addEventListener('close', (event) => {
      clearInterval(pinging);
      reject(new Error(`B closed the socket, ${event.code}`));
      say('b', `socket closed ${event.code} ${event.reason}`);
      if (listener?.close !== close) return;
      listener = undefined;
      showClient();
      // B ends a socket at its token's expiry, and the network can drop one. The page reopens it
      // with a new token and secret, and refreshes each subscription to name the new secret. A
      // newer socket of b's own, or a Wipe, closes one with nothing to reopen.
      if (!closedByPage && event.code !== 4000 && event.code !== 1012) run('b', reconnect);
    });
  });
  socket.addEventListener('open', () => socket.send(JSON.stringify({ secret })));
  await registered;
  say('b', `socket open on B, secret registered`);
  return {
    hookUrl: `${ORIGIN}/gateway/${GATEWAY}/hooks/${b.clientId()}`,
    secret,
    // A sleeping laptop sends nothing, and leaves its socket open.
    sleep: () => clearInterval(pinging),
    wake: () => {
      socket.send('ping');
      ping();
    },
    close,
  };
}

let reopenDelay = 500;

// Reopens b's socket, trying again with a growing wait while B cannot be reached, and then
// refreshes each subscription, at both levels, to name the new secret.
async function reconnect(): Promise<void> {
  try {
    listener = await listen();
  } catch (error) {
    say('b', `reopening the socket failed, trying again in ${reopenDelay} ms: ${error instanceof Error ? error.message : String(error)}`);
    setTimeout(() => run('b', reconnect), reopenDelay);
    reopenDelay = Math.min(reopenDelay * 2, RECONNECT_MAX_MS);
    return;
  }
  reopenDelay = 500;
  showClient();
  for (const [id, uri] of [...eventSubscriptions]) {
    eventSubscriptions.delete(id);
    await subscribeEvent(uri);
  }
  for (const { target } of copies.subscriptions()) await copies.refresh(target);
  showClient();
}

async function subscribeEvent(uri: string): Promise<void> {
  const hook = await listening();
  const result = await b.mcp.request<{ resultType: 'complete'; id: string }>('events/subscribe', {
    name: 'mcp.resource.updated',
    arguments: { uri },
    delivery: { mode: 'webhook', url: hook.hookUrl, secret: hook.secret },
  });
  eventSubscriptions.set(result.id, uri);
  say('b', `events/subscribe → ${short(result)}`);
}

const a = client('a');
const b = client('b');
const A = backChannel('A');
const B = backChannel('B');

function uriOf(name: string): string {
  return `${ROOT}/${input(name).value.replace(/^\/+/, '')}`;
}

// What each button does. Each runs one at a time, and shows a failure in its party's box.
const ACTIONS: Record<string, [Party, () => Promise<void>]> = {
  'a-write': [
    'a',
    async () => {
      const uri = uriOf('a-path');
      const result = await a.mcp.request('tools/call', { name: 'write_note', arguments: { uri, note: { title: input('a-title').value, done: false } } });
      const version = (result.structuredContent as { version: string }).version;
      written.set(uri, version);
      say('a', `write_note ${uri} → ${version}`);
      showWriter();
    },
  ],
  'a-delete': [
    'a',
    async () => {
      const uri = uriOf('a-path');
      const result = await a.mcp.request('tools/call', { name: 'delete_note', arguments: { uri } });
      const version = (result.structuredContent as { version: string }).version;
      written.set(uri, `${version}, deleted`);
      say('a', `delete_note ${uri} → ${version}`);
      showWriter();
    },
  ],
  'b-read': [
    'b',
    async () => {
      const uri = uriOf('b-path');
      const result = await b.mcp.request('resources/read', { uri });
      say('b', `resources/read ${uri} → ${short(result.contents, LONG)}`);
    },
  ],
  'b-get': [
    'b',
    async () => {
      const uri = uriOf('b-path');
      const response = await fetch(uri);
      const etag = response.headers.get('ETag');
      if (etag) etags.set(uri, etag);
      say('b', `GET ${uri} → ${response.status}${etag ? ` ETag ${etag}` : ''} ${await response.text()}`);
    },
  ],
  'b-get-if-changed': [
    'b',
    async () => {
      const uri = uriOf('b-path');
      const etag = etags.get(uri);
      const response = await fetch(uri, { headers: etag ? { 'If-None-Match': etag } : {} });
      const now = response.headers.get('ETag');
      if (now) etags.set(uri, now);
      say('b', `GET ${uri}${etag ? ` If-None-Match ${etag}` : ''} → ${response.status}${response.status === 304 ? '' : ` ${await response.text()}`}`);
    },
  ],
  'b-subscribe-event': [
    'b',
    async () => {
      await subscribeEvent(uriOf('b-path'));
      showClient();
    },
  ],
  'b-subscribe': [
    'b',
    async () => {
      const target = { uri: uriOf('b-path') };
      seen.add(target.uri);
      await copies.refresh(target);
      showClient();
    },
  ],
  'b-sleep': [
    'b',
    async () => {
      listener?.sleep();
      asleep = true;
      say('b', 'the laptop sleeps');
      showClient();
    },
  ],
  'b-wake': [
    'b',
    async () => {
      asleep = false;
      listener?.wake();
      say('b', 'the laptop wakes');
      showClient();
    },
  ],
};

// The header's controls, sent over the back channels with the operator token.
const CONTROLS: Record<string, () => Promise<void>> = {
  wipe: async () => {
    const answers = await Promise.all([A.control('wipe'), B.control('wipe')]);
    showControl(answers);
    if (!answers.every((answer) => answer.type === 'done')) return;
    // A forgot every registration and B closed every socket, so a and b start over. A and B report
    // what they now hold, so only the page's own records and the messages are cleared here.
    listener?.close();
    listener = undefined;
    asleep = false;
    for (const party of ['a', 'A', 'B', 'b'] as const) element(`[data-party="${party}"] .messages`).replaceChildren();
    written.clear();
    eventSubscriptions.clear();
    etags.clear();
    seen.clear();
    copies = newCopies();
    await start();
  },
  schedule: async () => {
    const delaysMs = input('schedule').value.split(',').map((delay) => Number(delay.trim()));
    showControl([await A.control('schedule', { delaysMs })]);
  },
  'schedule-default': async () => showControl([await A.control('schedule', { delaysMs: null })]),
};

function showControl(answers: Message[]): void {
  element('[data-control-answer]').textContent = answers.map((answer) => `${answer.action as string}: ${answer.type as string}`).join(', ');
}

async function start(): Promise<void> {
  await signIn('a', a);
  showWriter();
  await signIn('b', b);
  listener = await listen();
  showClient();
}

let queue = Promise.resolve();

function run(party: Party, action: () => Promise<void>): void {
  queue = queue.then(action).catch((error: unknown) => say(party, `failed: ${error instanceof Error ? error.message : String(error)}`));
}

const tokenInput = input('operator-token');
tokenInput.value = sessionStorage.getItem(OPERATOR_TOKEN_KEY) ?? '';
tokenInput.addEventListener('change', () => sessionStorage.setItem(OPERATOR_TOKEN_KEY, tokenInput.value));

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
  const name = button.dataset.action!;
  button.addEventListener('click', () => {
    const control = CONTROLS[name];
    if (control) return run('b', control);
    const [party, action] = ACTIONS[name];
    run(party, action);
  });
}

run('b', async () => {
  await start();
  document.body.dataset.ready = 'true';
});
