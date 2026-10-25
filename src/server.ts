// A, the server that holds the notes, the authorization server its clients get tokens from, and
// the sender of every webhook delivery. Its page back channel reports what it holds and sends.
import { DurableObject } from 'cloudflare:workers';
import { AuthorizationServer } from './auth/authorization-server';
import { mcpEndpoint, resourceMetadataUrl } from './auth/metadata';
import { acceptPage, authorized, PAGE_TAG, report, type Control } from './back-channel';
import { CLAIMS_HEADER } from './edge';
import { serveMcp } from './mcp-http';
import { serveNotes } from './notes-http';
import type { Send } from './server-role/deliveries';
import { ServerRole, type ServerExtras } from './server-role/server-role';

interface Claims {
  sub: string;
  epoch: number;
}

export class Server extends DurableObject<Env> {
  /** What a subclass adds to A's tools and resources, as the conformance build's fixtures. */
  static extras: ServerExtras = {};

  readonly #role: ServerRole;
  readonly #authorization: AuthorizationServer;
  readonly #base: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The edge sends A only requests for its own instance, by name, so the name is present.
    const name = ctx.id.name!;
    this.#base = `/server/${name}`;
    const timeoutMs = Number(env.ATTEMPT_TIMEOUT_MS);
    // A delivery never follows a redirect, so any 3xx is a failed attempt and its Location is
    // never fetched.
    const send: Send = async (url, headers, body) => {
      try {
        const response = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        return { status: response.status, body: await response.text() };
      } catch (error) {
        return { failure: (error as Error).name === 'TimeoutError' ? 'timeout' : 'connection_refused' };
      }
    };
    this.#role = new ServerRole({
      sql: ctx.storage.sql,
      root: `${env.ORIGIN}${this.#base}`,
      cutoffWindowMs: Number(env.CUTOFF_WINDOW_MS),
      extras: (new.target as typeof Server).extras,
      send,
      waitUntil: (promise) => ctx.waitUntil(promise),
      retrySchedule: () => (ctx.storage.kv.get('retrySchedule') as number[] | undefined) ?? env.RETRY_SCHEDULE_MS.split(',').map(Number),
      verificationBurst: Number(env.VERIFICATION_BURST),
      subscriptionIdKey: env.SUBSCRIPTION_ID_KEY,
      maxTtlMs: Number(env.SUBSCRIPTION_TTL_MS),
      subscriptionCap: Number(env.SUBSCRIPTION_CAP),
      report: (body) => report(ctx, 'A', body),
    });
    this.#authorization = new AuthorizationServer({
      sql: ctx.storage.sql,
      secret: env.TOKEN_SIGNING_KEY,
      origin: env.ORIGIN,
      epoch: () => this.#role.store.epoch(),
      resourcesFor: (clientId) => [mcpEndpoint(env.ORIGIN, name), `${env.ORIGIN}/gateway/${env.GATEWAY_INSTANCE}/ws/${clientId}`],
      registrationCap: Number(env.REGISTRATION_CAP),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/register':
        return this.#authorization.register(request);
      case '/authorize':
        return this.#authorization.authorize(url);
      case '/token':
        return this.#authorization.token(request);
    }
    const path = url.pathname.slice(this.#base.length);
    if (path === '/page') return acceptPage(this.ctx);
    const needsToken = path === '/mcp' || request.method === 'PUT' || request.method === 'DELETE';
    let claims: Claims | undefined;
    if (needsToken) {
      claims = this.#currentClaims(request);
      if (!claims) return this.#staleToken();
    }
    if (path === '/mcp') return serveMcp(request, this.#role, claims?.sub, (body) => report(this.ctx, 'A', body));
    return serveNotes(request, path, `${this.env.ORIGIN}${this.#base}`, this.#role.store);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || !this.ctx.getTags(socket).includes(PAGE_TAG)) return;
    let control: Control;
    try {
      control = JSON.parse(message) as Control;
    } catch {
      return;
    }
    if (control.type !== 'control') return;
    if (!authorized(control, this.env.OPERATOR_TOKEN)) {
      socket.send(JSON.stringify({ type: 'refused', action: control.action }));
      return;
    }
    if (control.action === 'wipe') {
      this.#authorization.clear();
      const epoch = this.#role.wipe();
      socket.send(JSON.stringify({ type: 'done', action: 'wipe', epoch }));
    } else if (control.action === 'schedule' && Array.isArray(control.delaysMs) && control.delaysMs.every((delay) => typeof delay === 'number')) {
      this.ctx.storage.kv.put('retrySchedule', control.delaysMs);
      socket.send(JSON.stringify({ type: 'done', action: 'schedule' }));
    }
  }

  // The edge verified the token, but only A knows its epoch, so a token from before a Wipe is
  // refused here.
  #currentClaims(request: Request): Claims | undefined {
    const claims = JSON.parse(request.headers.get(CLAIMS_HEADER) ?? 'null') as Claims | null;
    return claims && claims.epoch === this.#role.store.epoch() ? claims : undefined;
  }

  #staleToken(): Response {
    const challenge = `Bearer resource_metadata="${resourceMetadataUrl(this.env.ORIGIN, this.ctx.id.name!)}", error="invalid_token"`;
    return Response.json(
      { error: 'invalid_token', error_description: 'The token was issued before the last Wipe' },
      { status: 401, headers: { 'WWW-Authenticate': challenge } },
    );
  }
}
