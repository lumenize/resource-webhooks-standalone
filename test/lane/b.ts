// The parties of level 1's scenarios: `a`, the writer, `b`, which subscribes and listens on its
// socket to B, and the page, which watches A's and B's back channels. Each of `a` and `b` is its
// own OAuth client of A, so each is its own principal.
import { env } from 'cloudflare:workers';
import { expect, vi } from 'vitest';
import { createMcpClient, OAuthSession, type McpClient } from '../../src/client/mcp-client';
import { newSecret } from '../../src/standard-webhooks';
import { callWorker, type Lane } from './lane';

export interface Party {
  client: McpClient;
  session: OAuthSession;
  clientId: string;
}

/** A client of A that has signed in, as a principal of its own. */
export async function signedIn(lane: Lane, name: string): Promise<Party> {
  const send = (input: RequestInfo | URL, init?: RequestInit) => callWorker(new Request(input, init), lane.env);
  const session = new OAuthSession({ redirectUri: `${env.ORIGIN}/callback`, clientName: name, fetch: send });
  const client = createMcpClient({ endpoint: `${lane.root}/mcp`, clientInfo: { name, version: '0.0.0' }, oauth: session, fetch: send });
  await session.tokenFor(`${lane.root}/mcp`);
  return { client, session, clientId: session.clientIdFor(env.ORIGIN)! };
}

/** A client's socket URL on B, as `.../gateway/B/ws/{clientId}`. */
export function socketUrl(lane: Lane, clientId: string): string {
  return `${env.ORIGIN}/gateway/${lane.gateway}/ws/${clientId}`;
}

/** A client's webhook URL on B, the `delivery.url` it subscribes with. */
export function hookUrl(lane: Lane, clientId: string): string {
  return `${env.ORIGIN}/gateway/${lane.gateway}/hooks/${clientId}`;
}

/** Opens an upgrade to `url` with `token` as the subprotocol entry, as a browser would send it. */
export function upgrade(lane: Lane, url: string, token?: string, headers: Record<string, string> = {}): Promise<Response> {
  const protocols = token === undefined ? 'rw.1' : `rw.1, rw.token.${token}`;
  return callWorker(new Request(url, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocols, ...headers } }), lane.env);
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
export async function listen(lane: Lane, party: Party, { secret = newSecret(), token }: { secret?: string; token?: string } = {}): Promise<Listener> {
  const url = socketUrl(lane, party.clientId);
  const response = await upgrade(lane, url, token ?? (await party.session.tokenForResource(env.ORIGIN, url)));
  expect(response.status).toBe(101);
  expect(response.headers.get('Sec-WebSocket-Protocol')).toBe('rw.1');
  const socket = response.webSocket!;
  socket.accept();
  const messages: Record<string, unknown>[] = [];
  const closes: { code: number; reason: string }[] = [];
  socket.addEventListener('message', (event) => {
    // The runtime answers a ping with a bare pong, which is not JSON.
    if (event.data !== 'pong') messages.push(JSON.parse(event.data as string));
  });
  const heartbeat = setInterval(() => socket.send('ping'), Number(env.HEARTBEAT_MS));
  socket.addEventListener('close', (event) => {
    clearInterval(heartbeat);
    closes.push({ code: event.code, reason: event.reason });
  });
  socket.send(JSON.stringify({ secret }));
  // b subscribes only once B has stored its secret, since A's challenge reaches B first.
  await vi.waitFor(() => expect(messages.find(({ type }) => type === 'secret-registered' || type === 'secret-refused')).toEqual({ type: 'secret-registered' }));
  return {
    closes,
    secret,
    hookUrl: hookUrl(lane, party.clientId),
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
   * Sends a control with the operator token, unless given another or `null` for none, and
   * returns A's or B's answer.
   */
  control(action: string, extra?: Record<string, unknown>, operatorToken?: string | null): Promise<Record<string, unknown>>;
  close(): void;
}

/** The page's back channel to A, or to B. */
export async function watch(lane: Lane, party: 'A' | 'B'): Promise<Page> {
  const path = party === 'A' ? `/server/${lane.name}/page` : `/gateway/${lane.gateway}/page`;
  const response = await callWorker(new Request(`${env.ORIGIN}${path}`, { headers: { Upgrade: 'websocket' } }), lane.env);
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const raw: string[] = [];
  socket.addEventListener('message', (event) => {
    raw.push(event.data as string);
  });
  const parsed = () => raw.map((text) => JSON.parse(text) as Record<string, unknown>);
  return {
    raw,
    reports: () => parsed().filter((message) => message.party === party),
    async control(action, extra = {}, operatorToken = env.OPERATOR_TOKEN) {
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
