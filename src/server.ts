// A, the server that holds the notes.
import { DurableObject } from 'cloudflare:workers';
import { serveMcp } from './mcp-http';
import { serveNotes } from './notes-http';
import { ServerRole, type ServerExtras } from './server-role/server-role';

export class Server extends DurableObject<Env> {
  /** What a subclass adds to A's tools and resources, as the conformance build's fixtures. */
  static extras: ServerExtras = {};

  readonly #role: ServerRole;
  readonly #base: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The edge routes only A's own instance here, by name, so the name is always present.
    this.#base = `/server/${ctx.id.name}`;
    this.#role = new ServerRole({
      sql: ctx.storage.sql,
      root: `${env.ORIGIN}${this.#base}`,
      cutoffWindowMs: Number(env.CUTOFF_WINDOW_MS),
      extras: (new.target as typeof Server).extras,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.slice(this.#base.length);
    if (path === '/mcp') return serveMcp(request, this.#role);
    return serveNotes(request, path, `${this.env.ORIGIN}${this.#base}`, this.#role.store);
  }
}
