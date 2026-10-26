// The demo page: four boxes, for the writer `a`, the server A, the gateway B and the client `b`.
// `a` and `b` run here, on the same client modules the tests use, so their boxes are their own
// records. A and B run on Cloudflare and report to the page over a back channel each, which
// feeds their boxes. Every value is shown as text, never parsed as HTML. The operator token
// is typed in and kept in sessionStorage, and never goes in a URL. The page's staging beyond the
// mechanics waits for rehearsal.
import { Copies, type Target } from '../client/copies.js';
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

function clearBoxes(): void {
  for (const party of ['a', 'A', 'B', 'b'] as const) {
    element(`[data-party="${party}"] .messages`).replaceChildren();
    hold(party, []);
  }
}

// A and B report every message whole, so a box shows the start of each. A client's own results
// are shown at greater length, since a catch-up's changes are what a beat is about.
function short(value: unknown, limit = 400): string {
  const text = JSON.stringify(value) ?? '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const LONG = 2000;

// A and B: what each back channel reports, and what the page reads off it as each one's holdings.

interface BackChannel {
  control(action: string, extra?: Message): Promise<Message>;
}

const serverHoldings = { notes: new Map<string, string>(), subscriptions: new Map<string, string>() };
const gatewayHoldings = { sockets: new Set<string>(), secrets: new Map<string, string>() };
let heartbeatMs = 30_000;

function showServer(): void {
  hold('A', [
    ...[...serverHoldings.notes].map(([uri, version]) => `note ${uri} at ${version}`),
    ...[...serverHoldings.subscriptions].map(([id, target]) => `subscription ${id} to ${target}`),
  ]);
}

function showGateway(): void {
  hold('B', [...[...gatewayHoldings.sockets].map((client) => `socket for ${client}`), ...[...gatewayHoldings.secrets].map(([client, secret]) => `secret for ${client}: ${secret}`)]);
}

// A reports each MCP exchange, so its notes and subscriptions are read off the answers.
function readServer(report: Message): void {
  if (report.kind !== 'mcp' || report.error) return;
  const params = (report.params ?? {}) as Message;
  const result = (report.result ?? {}) as Message;
  if (report.method === 'tools/call') {
    const uri = (params.arguments as Message | undefined)?.uri as string | undefined;
    const version = (result.structuredContent as Message | undefined)?.version as string | undefined;
    if (uri && version) serverHoldings.notes.set(uri, params.name === 'delete_note' ? `${version}, deleted` : version);
  }
  if ((report.method === 'events/subscribe' || report.method === 'resources/webhooks/subscribe') && typeof result.id === 'string') {
    const target = params.uri ?? params.uriTemplate ?? (params.listed ? 'listed' : undefined) ?? (params.arguments as Message | undefined)?.uri;
    serverHoldings.subscriptions.set(result.id, `${target}, until ${result.refreshBefore ?? 'cancelled'}`);
  }
  showServer();
}

function readGateway(report: Message): void {
  if (report.kind === 'connected') gatewayHoldings.sockets.add(report.client as string);
  if (report.kind === 'secret-registered') gatewayHoldings.secrets.set(report.client as string, report.secret as string);
  showGateway();
}

function describe(report: Message): string {
  const { party: _party, kind, method, ...rest } = report;
  return `${kind}${method ? ` ${method}` : ''} ${short(rest)}`;
}

function backChannel(party: 'A' | 'B'): BackChannel {
  const path = party === 'A' ? `/server/${SERVER}/page` : `/gateway/${GATEWAY}/page`;
  const socket = new WebSocket(`${ORIGIN.replace(/^http/, 'ws')}${path}`);
  const opened = new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  const answers: ((message: Message) => boolean)[] = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data as string) as Message;
    if (message.party === party) {
      if (message.kind === 'hello' && typeof message.heartbeatMs === 'number') heartbeatMs = message.heartbeatMs;
      say(party, describe(message));
      if (party === 'A') readServer(message);
      else readGateway(message);
      return;
    }
    // An answer to a control, which the page shows in the header and never in a box.
    for (const [index, take] of answers.entries()) {
      if (!take(message)) continue;
      answers.splice(index, 1);
      return;
    }
  });
  return {
    async control(action, extra = {}) {
      await opened;
      const operatorToken = sessionStorage.getItem(OPERATOR_TOKEN_KEY) ?? '';
      const answer = new Promise<Message>((resolve) => answers.push((message) => (message.action === action ? (resolve(message), true) : false)));
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
const eventSubscriptions = new Set<string>();
const etags = new Map<string, string>();
const seen = new Set<string>();
let listener: Listener | undefined;
let asleep = false;

function newCopies(): Copies {
  return new Copies(async (target, { version, cursor }) => {
    const result = await b.mcp.request<ResourceWebhookSubscribeResult>('resources/webhooks/subscribe', {
      ...target,
      delivery: { url: listener!.hookUrl, secret: listener!.secret },
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
  for (const id of eventSubscriptions) lines.push(`event subscription ${id}`);
  for (const uri of [...seen].sort()) {
    const copy = copies.get(uri);
    if (copy) lines.push(`${uri} at ${copy.version}${copy.deleted ? ', deleted' : titleOf(uri)}`);
  }
  hold('b', lines);
}

async function listen(): Promise<Listener> {
  const url = `${ORIGIN}/gateway/${GATEWAY}/ws/${b.clientId()}`;
  const token = await b.session.tokenForResource(ORIGIN, url);
  const socket = new WebSocket(url.replace(/^http/, 'ws'), ['rw.1', `rw.token.${token}`]);
  const secret = newSecret();
  let pinging: ReturnType<typeof setInterval> | undefined;
  const ping = () => {
    clearInterval(pinging);
    pinging = setInterval(() => socket.send('ping'), heartbeatMs);
  };
  const registered = new Promise<void>((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      if (event.data === 'pong') return;
      const message = JSON.parse(event.data as string) as Message;
      if (message.type === 'secret-registered') return resolve();
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
    socket.addEventListener('error', () => reject(new Error('B refused the socket')));
    socket.addEventListener('close', (event) => {
      clearInterval(pinging);
      say('b', `socket closed ${event.code} ${event.reason}`);
      if (listener?.close === close) listener = undefined;
      showClient();
    });
  });
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ secret }));
    ping();
  });
  const close = () => socket.close(1000, 'Done');
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

const a = client('a');
const b = client('b');
const A = backChannel('A');
const B = backChannel('B');

function targetOf(path: string): { uri: string } {
  return { uri: `${ROOT}/${path.replace(/^\/+/, '')}` };
}

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
      const uri = uriOf('b-path');
      const result = await b.mcp.request<{ resultType: 'complete'; id: string }>('events/subscribe', {
        name: 'mcp.resource.updated',
        arguments: { uri },
        delivery: { mode: 'webhook', url: listener!.hookUrl, secret: listener!.secret },
      });
      eventSubscriptions.add(result.id);
      say('b', `events/subscribe → ${short(result)}`);
      showClient();
    },
  ],
  'b-subscribe': [
    'b',
    async () => {
      const target = targetOf(input('b-path').value);
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
      listener?.wake();
      asleep = false;
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
    // A forgot every registration and B closed every socket, so a and b start over.
    listener?.close();
    listener = undefined;
    clearBoxes();
    serverHoldings.notes.clear();
    serverHoldings.subscriptions.clear();
    gatewayHoldings.sockets.clear();
    gatewayHoldings.secrets.clear();
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
