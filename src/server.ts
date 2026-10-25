// A, the server that holds the notes, and the authorization server its clients get tokens from.
import { DurableObject } from 'cloudflare:workers';
import { AuthorizationServer } from './auth/authorization-server';
import { mcpEndpoint, resourceMetadataUrl } from './auth/metadata';
import { CLAIMS_HEADER } from './edge';
import { serveMcp } from './mcp-http';
import { serveNotes } from './notes-http';
import { ServerRole, type ServerExtras } from './server-role/server-role';

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
    this.#role = new ServerRole({
      sql: ctx.storage.sql,
      root: `${env.ORIGIN}${this.#base}`,
      cutoffWindowMs: Number(env.CUTOFF_WINDOW_MS),
      extras: (new.target as typeof Server).extras,
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
    const needsToken = path === '/mcp' || request.method === 'PUT' || request.method === 'DELETE';
    if (needsToken) {
      const stale = this.#staleTokenGuard(request);
      if (stale) return stale;
    }
    if (path === '/mcp') return serveMcp(request, this.#role);
    return serveNotes(request, path, `${this.env.ORIGIN}${this.#base}`, this.#role.store);
  }

  // The edge verified the token, but only A knows its epoch, so a token from before a Wipe is
  // refused here.
  #staleTokenGuard(request: Request): Response | undefined {
    const claims = JSON.parse(request.headers.get(CLAIMS_HEADER) ?? 'null') as { epoch: number } | null;
    if (claims && claims.epoch === this.#role.store.epoch()) return undefined;
    const challenge = `Bearer resource_metadata="${resourceMetadataUrl(this.env.ORIGIN, this.ctx.id.name!)}", error="invalid_token"`;
    return Response.json(
      { error: 'invalid_token', error_description: 'The token was issued before the last Wipe' },
      { status: 401, headers: { 'WWW-Authenticate': challenge } },
    );
  }
}
