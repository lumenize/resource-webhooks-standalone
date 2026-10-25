// B, the gateway: a webhook receiver for each of its clients, and each client's WebSocket. It
// keeps a client's secret in the socket's attachment and stores nothing. The edge has checked
// the token on a client's upgrade, and passes its claims in CLAIMS_HEADER.
import { DurableObject } from 'cloudflare:workers';
import { acceptPage, authorized, PAGE_TAG, report, type Control } from './back-channel';
import { CLAIMS_HEADER } from './edge';
import { readCapped } from './read-capped';
import { GatewayRole, type Forwarded } from './gateway-role/gateway-role';
import { secretBytes } from './standard-webhooks';

/** The subprotocol B and its clients speak on the socket. */
export const SUBPROTOCOL = 'rw.1';
/** The close code for a socket whose token has expired. */
export const TOKEN_EXPIRED = 4401;
/** The close code for a socket a newer one from the same client replaced. */
export const SUPERSEDED = 4000;

interface Attachment {
  client: string;
  /** The token's expiry, in seconds since the epoch. */
  exp: number;
  /** When the socket opened, as an ISO string. */
  connectedAt: string;
  secret?: string;
}

export class Gateway extends DurableObject<Env> {
  readonly #role: GatewayRole;
  // How often a client pings, so B can tell a sleeping laptop's socket from a live one.
  readonly #heartbeatMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#heartbeatMs = Number(env.HEARTBEAT_MS);
    // Answered by the runtime without waking B, and timestamped, so B can read the last ping.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.#role = new GatewayRole({
      secretFor: (client) => this.#liveSocket(client)?.attachment.secret,
      forward: (client, message) => this.#forward(client, message),
      report: (body) => report(this.ctx, 'B', body),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const name = this.ctx.id.name!;
    const path = new URL(request.url).pathname.slice(`/gateway/${name}`.length);
    if (path === '/page') return acceptPage(this.ctx);
    const socket = /^\/ws\/([^/]+)$/.exec(path);
    if (socket) return await this.#acceptClient(socket[1], request);
    const hook = /^\/hooks\/([^/]+)$/.exec(path);
    if (hook && request.method === 'POST') {
      const bytes = await readCapped(request.body);
      if (!bytes) return new Response('Content Too Large', { status: 413 });
      const answer = await this.#role.receive(hook[1], request.headers, bytes);
      return new Response(answer.body ?? null, { status: answer.status, headers: answer.body?.startsWith('{') ? { 'Content-Type': 'application/json' } : {} });
    }
    return new Response('Not Found', { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let parsed: { secret?: unknown; type?: unknown };
    try {
      parsed = JSON.parse(message) as typeof parsed;
    } catch {
      return;
    }
    if (this.ctx.getTags(socket).includes(PAGE_TAG)) {
      if (parsed.type === 'control') this.#control(socket, parsed as Control);
      return;
    }
    if (!('secret' in parsed)) return;
    const attachment = socket.deserializeAttachment() as Attachment;
    if (typeof parsed.secret !== 'string' || !secretBytes(parsed.secret)) {
      socket.send(JSON.stringify({ type: 'secret-refused' }));
      return;
    }
    socket.serializeAttachment({ ...attachment, secret: parsed.secret } satisfies Attachment);
    socket.send(JSON.stringify({ type: 'secret-registered' }));
    report(this.ctx, 'B', { kind: 'secret-registered', client: attachment.client, secret: parsed.secret });
  }

  async alarm(): Promise<void> {
    this.#closeExpired();
    await this.#scheduleExpiry();
  }

  async #acceptClient(client: string, request: Request): Promise<Response> {
    // The edge checked the token's signature, expiry and audience, and that it was issued to the
    // client the path names.
    const claims = JSON.parse(request.headers.get(CLAIMS_HEADER) ?? 'null') as { exp: number } | null;
    if (!claims) return new Response('Unauthorized', { status: 401 });
    const [browserSide, server] = Object.values(new WebSocketPair());
    // A client that reconnects replaces its older sockets, as Lumenize's ClientGateway does.
    for (const older of this.ctx.getWebSockets(`client:${client}`)) older.close(SUPERSEDED, 'Superseded by a newer connection');
    this.ctx.acceptWebSocket(server, [`client:${client}`]);
    server.serializeAttachment({ client, exp: claims.exp, connectedAt: new Date().toISOString() } satisfies Attachment);
    await this.#scheduleExpiry();
    report(this.ctx, 'B', { kind: 'connected', client });
    return new Response(null, { status: 101, webSocket: browserSide, headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL } });
  }

  // The client's socket, if its token is unexpired and it has pinged within two intervals. A
  // client has one socket at most, since accepting one closes the rest, and the runtime drops a
  // socket from getWebSockets as soon as B closes it.
  #liveSocket(client: string): { socket: WebSocket; attachment: Attachment } | undefined {
    this.#closeExpired();
    const [socket] = this.ctx.getWebSockets(`client:${client}`);
    if (!socket) return undefined;
    const attachment = socket.deserializeAttachment() as Attachment;
    const lastSeen = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? Date.parse(attachment.connectedAt);
    return Date.now() - lastSeen > 2 * this.#heartbeatMs ? undefined : { socket, attachment };
  }

  #forward(client: string, message: Forwarded): boolean {
    const live = this.#liveSocket(client);
    live?.socket.send(JSON.stringify({ type: 'delivery', ...message }));
    return Boolean(live);
  }

  #closeExpired(): void {
    const now = Date.now() / 1000;
    for (const socket of this.ctx.getWebSockets()) {
      if (this.ctx.getTags(socket).includes(PAGE_TAG)) continue;
      const { exp } = socket.deserializeAttachment() as Attachment;
      if (exp <= now) socket.close(TOKEN_EXPIRED, 'The token has expired');
    }
  }

  // One alarm, at the earliest expiry among the open sockets, so an idle socket is closed too. It
  // is set only when a socket opens or the alarm fires, never per delivery, since each is a write.
  async #scheduleExpiry(): Promise<void> {
    const now = Date.now() / 1000;
    const expiries = this.ctx
      .getWebSockets()
      .filter((socket) => !this.ctx.getTags(socket).includes(PAGE_TAG))
      .map((socket) => (socket.deserializeAttachment() as Attachment).exp)
      .filter((exp) => exp > now);
    if (expiries.length === 0) return;
    const next = Math.min(...expiries) * 1000;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current || current <= Date.now()) await this.ctx.storage.setAlarm(next);
  }

  #control(page: WebSocket, control: Control): void {
    if (!authorized(control, this.env.OPERATOR_TOKEN)) {
      page.send(JSON.stringify({ type: 'refused', action: control.action }));
      return;
    }
    if (control.action === 'wipe') {
      for (const socket of this.ctx.getWebSockets()) if (!this.ctx.getTags(socket).includes(PAGE_TAG)) socket.close(1012, 'Wiped');
      page.send(JSON.stringify({ type: 'done', action: 'wipe' }));
    } else {
      page.send(JSON.stringify({ type: 'unknown', action: control.action }));
    }
  }
}
