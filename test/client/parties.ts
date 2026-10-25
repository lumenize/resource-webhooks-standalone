// The parties of the scenarios: `a`, the writer, `b`, which subscribes and listens on its socket to
// B, and the page, which watches A's and B's back channels. They speak only HTTP and WebSocket to
// a tier, the lane's Worker or a deployed one, so a scenario runs unchanged against either. Each of
// `a` and `b` is its own OAuth client of A, so each is its own principal.
import { expect, vi } from 'vitest';
import { createMcpClient, OAuthSession, type McpClient } from '../../src/client/mcp-client';
import { newSecret } from '../../src/standard-webhooks';

/** What a scenario runs against: the lane's Worker, or a deployed one. */
export interface Tier {
  /** The Worker's origin, as `https://test-resource-webhooks-standalone.transformation.workers.dev`. */
  origin: string;
  /** A's instance name, as `A` deployed or `A-1f2e3d4c` in the lane. */
  name: string;
  /** B's instance name, `B`. */
  gateway: string;
  /** A's own URI, `{origin}/server/{name}`. */
  root: string;
  /** How often a client pings B, in milliseconds. */
  heartbeatMs: number;
  /** What the page's controls carry, if this tier has one. */
  operatorToken?: string;
  /** Sends a request to the Worker, as fetch does, without following a redirect itself. */
  send(request: Request): Promise<Response>;
  /** Opens a socket to the Worker offering these subprotocols, and resolves once it is open. */
  connect(url: string, protocols: string[]): Promise<Socket>;
}

/** A socket to the Worker, whichever WebSocket implementation the tier has. */
export interface Socket {
  /** The subprotocol the Worker chose, or `''`. */
  protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
}

/** A tier's Socket over a standard WebSocket that is already open. */
export function socketOf(socket: WebSocket, protocol: string): Socket {
  return {
    protocol,
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (listener) => socket.addEventListener('message', (event) => listener(event.data as string)),
    onClose: (listener) => socket.addEventListener('close', (event) => listener(event.code, event.reason)),
  };
}

export interface Party {
  client: McpClient;
  session: OAuthSession;
  clientId: string;
}

/** A client of A that has signed in, as a principal of its own. */
export async function signedIn(tier: Tier, name: string): Promise<Party> {
  const send = (input: RequestInfo | URL, init?: RequestInit) => tier.send(new Request(input, init));
  const session = new OAuthSession({ redirectUri: `${tier.origin}/callback`, clientName: name, fetch: send });
  const client = createMcpClient({ endpoint: `${tier.root}/mcp`, clientInfo: { name, version: '0.0.0' }, oauth: session, fetch: send });
  await session.tokenFor(`${tier.root}/mcp`);
  return { client, session, clientId: session.clientIdFor(tier.origin)! };
}

/** Writes a note through `write_note`, and returns the version it got. */
export async function write(party: Party, uri: string, title = 'Buy milk'): Promise<string> {
  const result = await party.client.request('tools/call', { name: 'write_note', arguments: { uri, note: { title, done: false } } });
  return (result.structuredContent as { version: string }).version;
}

/** A client's socket URL on B, as `.../gateway/B/ws/{clientId}`. */
export function socketUrl(tier: Tier, clientId: string): string {
  return `${tier.origin}/gateway/${tier.gateway}/ws/${clientId}`;
}

/** A client's webhook URL on B, the `delivery.url` it subscribes with. */
export function hookUrl(tier: Tier, clientId: string): string {
  return `${tier.origin}/gateway/${tier.gateway}/hooks/${clientId}`;
}

export interface Listener {
  closes: { code: number; reason: string }[];
  secret: string;
  hookUrl: string;
  /** The events B passed down, with each one's parsed body. */
  deliveries(): { subscriptionId: string; webhookId: string; body: Record<string, unknown> }[];
  /** Stops the heartbeat, as a sleeping laptop does, and leaves the socket open. */
  stopPinging(): void;
  close(): void;
}

/**
 * Opens a client's socket to B with a token for that socket, a new one unless given one, pings
 * on B's heartbeat as `b` does, and registers a secret on it, waiting for B's acknowledgement.
 */
export async function listen(tier: Tier, party: Party, { secret = newSecret(), token }: { secret?: string; token?: string } = {}): Promise<Listener> {
  const url = socketUrl(tier, party.clientId);
  const socket = await tier.connect(url, ['rw.1', `rw.token.${token ?? (await party.session.tokenForResource(tier.origin, url))}`]);
  expect(socket.protocol).toBe('rw.1');
  const messages: Record<string, unknown>[] = [];
  const closes: { code: number; reason: string }[] = [];
  socket.onMessage((data) => {
    // The runtime answers a ping with a bare pong, which is not JSON.
    if (data !== 'pong') messages.push(JSON.parse(data));
  });
  const heartbeat = setInterval(() => socket.send('ping'), tier.heartbeatMs);
  socket.onClose((code, reason) => {
    clearInterval(heartbeat);
    closes.push({ code, reason });
  });
  socket.send(JSON.stringify({ secret }));
  // b subscribes only once B has stored its secret, since A's challenge reaches B first.
  await vi.waitFor(() => expect(messages.find(({ type }) => type === 'secret-registered' || type === 'secret-refused')).toEqual({ type: 'secret-registered' }));
  return {
    closes,
    secret,
    hookUrl: hookUrl(tier, party.clientId),
    deliveries: () =>
      messages
        .filter((message) => message.type === 'delivery')
        .map((message) => ({
          subscriptionId: message.subscriptionId as string,
          webhookId: message.webhookId as string,
          body: JSON.parse(message.body as string) as Record<string, unknown>,
        })),
    stopPinging: () => clearInterval(heartbeat),
    close: () => {
      clearInterval(heartbeat);
      socket.close(1000, 'Done');
    },
  };
}

/** `b`'s subscription to one resource at level 1. */
export function subscribe(party: Party, uri: string, url: string, secret: string, extra: Record<string, unknown> = {}) {
  return party.client.request('events/subscribe', {
    name: 'mcp.resource.updated',
    arguments: { uri },
    delivery: { mode: 'webhook', url, secret },
    cursor: null,
    ttlMs: 3_600_000,
    ...extra,
  });
}

export interface Page {
  /** Every report and answer the back channel sent, as raw text, before parsing. */
  raw: string[];
  reports(): Record<string, unknown>[];
  /**
   * Sends a control with the tier's operator token, unless given another or `null` for none,
   * and returns A's or B's answer.
   */
  control(action: string, extra?: Record<string, unknown>, operatorToken?: string | null): Promise<Record<string, unknown>>;
  close(): void;
}

/** The page's back channel to A, or to B. */
export async function watch(tier: Tier, party: 'A' | 'B'): Promise<Page> {
  const path = party === 'A' ? `/server/${tier.name}/page` : `/gateway/${tier.gateway}/page`;
  const socket = await tier.connect(`${tier.origin}${path}`, []);
  const raw: string[] = [];
  socket.onMessage((data) => {
    raw.push(data);
  });
  const parsed = () => raw.map((text) => JSON.parse(text) as Record<string, unknown>);
  return {
    raw,
    reports: () => parsed().filter((message) => message.party === party),
    async control(action, extra = {}, operatorToken = tier.operatorToken) {
      const before = raw.length;
      socket.send(JSON.stringify({ type: 'control', operatorToken, action, ...extra }));
      let answer: Record<string, unknown> | undefined;
      await vi.waitFor(() => {
        answer = parsed()
          .slice(before)
          .find((message) => ['done', 'refused', 'unknown'].includes(message.type as string) && message.action === action);
        expect(answer).toBeDefined();
      });
      return answer!;
    },
    close: () => socket.close(1000, 'Done'),
  };
}
