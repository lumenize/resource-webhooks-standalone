// A, the server that holds the notes.
import { DurableObject } from 'cloudflare:workers';
import { serveNotes } from './notes-http';
import { VersionStore } from './version-store';

export class Server extends DurableObject<Env> {
  readonly #store: VersionStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new VersionStore(ctx.storage.sql, { cutoffWindowMs: Number(env.CUTOFF_WINDOW_MS) });
  }

  async fetch(request: Request): Promise<Response> {
    // The edge routes only A's own instance here, by name, so the name is always present.
    const base = `/server/${this.ctx.id.name}`;
    const path = new URL(request.url).pathname.slice(base.length);
    return serveNotes(request, path, `${this.env.ORIGIN}${base}`, this.#store);
  }
}
