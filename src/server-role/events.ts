// Level 1: SEP-3415's own methods for one event type, `mcp.resource.updated`, as its Open
// Question 2 sketches it. A offers no replay, so every cursor is null. Subscriptions live in a
// table keyed by what they listen for, who asked and where they deliver, so a write finds the
// ones covering its URI by the key.
import { JsonRpcError } from '../json-rpc';
import {
  FORBIDDEN,
  NOT_FOUND,
  RESOURCE_EXHAUSTED,
  UNSUPPORTED,
  type EventOccurrence,
  type EventsListResult,
  type EventsSubscribeRequestParams,
  type EventsSubscribeResult,
  type EventsUnsubscribeRequestParams,
  type EventType,
} from '../events-types';
import { secretBytes } from '../standard-webhooks';
import { INVALID_PARAMS, type Result } from '../vendor/mcp-spec/2026-07-28/schema';
import { randomId, type Deliveries } from './deliveries';
import { parseTarget } from './targets';

export const RESOURCE_UPDATED = 'mcp.resource.updated';
const TARGET_KIND = `event:${RESOURCE_UPDATED}`;

const RESOURCE_UPDATED_TYPE: EventType = {
  name: RESOURCE_UPDATED,
  description: 'A resource changed',
  delivery: ['webhook'],
  inputSchema: { type: 'object', required: ['uri'], properties: { uri: { type: 'string' } }, additionalProperties: false },
  payloadSchema: { type: 'object', required: ['uri'], properties: { uri: { type: 'string' } } },
};

export interface EventsOptions {
  sql: SqlStorage;
  /** A's own URI, as `https://….workers.dev/server/A`. */
  root: string;
  deliveries: Deliveries;
  /** Keys the hash a subscription's id is derived by, a secret of its own. */
  subscriptionIdKey: string;
  /** The longest lifetime A grants, and the one it grants when asked for none or for no expiry. */
  maxTtlMs: number;
  /** How many subscriptions one principal may hold. */
  subscriptionCap: number;
}

interface SubscriptionRow extends Record<string, SqlStorageValue> {
  id: string;
  url: string;
  secret: string;
  expiresAt: string;
}

export class Events {
  readonly #options: EventsOptions;
  readonly #sql: SqlStorage;

  constructor(options: EventsOptions) {
    this.#options = options;
    this.#sql = options.sql;
    options.sql.exec(`
      CREATE TABLE IF NOT EXISTS Subscriptions (
        targetKind TEXT NOT NULL,
        target TEXT NOT NULL,
        principal TEXT NOT NULL,
        url TEXT NOT NULL,
        id TEXT NOT NULL,
        secret TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        PRIMARY KEY (targetKind, target, principal, url)
      ) WITHOUT ROWID;
    `);
    // Expired subscriptions are swept when A wakes, and skipped lazily at delivery.
    options.sql.exec('DELETE FROM Subscriptions WHERE expiresAt < ?', new Date().toISOString());
  }

  list(): EventsListResult {
    return { resultType: 'complete', events: [RESOURCE_UPDATED_TYPE] };
  }

  async subscribe(params: EventsSubscribeRequestParams, principal: string | undefined): Promise<EventsSubscribeResult> {
    const { uri, url } = this.#key(params, principal);
    const { secret } = params.delivery;
    if (!secretBytes(secret)) throw new JsonRpcError(INVALID_PARAMS, 'delivery.secret must be whsec_ and the base64 of 24 to 64 bytes');
    const held = this.#sql
      .exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM Subscriptions WHERE principal = ? AND NOT (targetKind = ? AND target = ? AND url = ?)',
        principal!,
        TARGET_KIND,
        uri,
        url,
      )
      .one().count;
    if (held >= this.#options.subscriptionCap) {
      throw new JsonRpcError(RESOURCE_EXHAUSTED, 'Too many subscriptions', { limit: 'subscriptions', max: this.#options.subscriptionCap });
    }
    const id = await this.#subscriptionId(principal!, url, uri);
    await this.#options.deliveries.requireVerified(principal!, url, secret, id);

    // The handshake awaited a fetch, so the row is written only now, in one synchronous step.
    const ttl = typeof params.ttlMs === 'number' ? Math.min(Math.max(params.ttlMs, 0), this.#options.maxTtlMs) : this.#options.maxTtlMs;
    const refreshBefore = new Date(Date.now() + ttl).toISOString();
    this.#sql.exec(
      'INSERT OR REPLACE INTO Subscriptions (targetKind, target, principal, url, id, secret, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      TARGET_KIND,
      uri,
      principal!,
      url,
      id,
      secret,
      refreshBefore,
    );
    return { resultType: 'complete', id, refreshBefore, cursor: null, truncated: false };
  }

  unsubscribe(params: EventsUnsubscribeRequestParams, principal: string | undefined): Result {
    const { uri, url } = this.#key(params, principal);
    const removed = this.#sql
      .exec('DELETE FROM Subscriptions WHERE targetKind = ? AND target = ? AND principal = ? AND url = ? RETURNING id', TARGET_KIND, uri, principal!, url)
      .toArray();
    if (removed.length === 0) throw new JsonRpcError(NOT_FOUND, 'No such subscription', { kind: 'subscription' });
    return { resultType: 'complete' };
  }

  /** Delivery modes A does not offer. */
  refuseMode(): never {
    throw new JsonRpcError(UNSUPPORTED, 'mcp.resource.updated is delivered by webhook only', { feature: 'deliveryMode' });
  }

  /**
   * Delivers one occurrence for a write at `uri`, to every live subscription for it or for a
   * folder above it. `version` is the write's, so each subscription carries the same eventId.
   */
  notify(uri: string, version: string): void {
    const now = new Date().toISOString();
    const body: EventOccurrence = { eventId: `evt_${version}`, name: RESOURCE_UPDATED, timestamp: now, data: { uri }, cursor: null };
    const text = JSON.stringify(body);
    for (const target of coveringTargets(uri, this.#options.root)) {
      const rows = this.#sql
        .exec<SubscriptionRow>('SELECT id, url, secret, expiresAt FROM Subscriptions WHERE targetKind = ? AND target = ?', TARGET_KIND, target)
        .toArray();
      for (const row of rows) {
        if (row.expiresAt < now) continue;
        const webhookId = `msg_${randomId(24)}`;
        this.#options.deliveries.enqueue(webhookId, { url: row.url, secret: row.secret, subscriptionId: row.id, webhookId, body: text });
      }
    }
  }

  /** Forgets every subscription, as a Wipe does. */
  clear(): void {
    this.#sql.exec('DELETE FROM Subscriptions');
  }

  #key(params: { name: string; arguments?: { [key: string]: unknown }; delivery: { url: string } }, principal: string | undefined) {
    if (!principal) throw new JsonRpcError(FORBIDDEN, 'Subscribing needs an authenticated principal');
    if (params.name !== RESOURCE_UPDATED) throw new JsonRpcError(NOT_FOUND, `No event type ${params.name}`, { kind: 'event' });
    const args = params.arguments ?? {};
    const extra = Object.keys(args).filter((key) => key !== 'uri');
    const uri = args.uri;
    if (typeof uri !== 'string' || extra.length > 0 || !this.#serves(uri)) {
      throw new JsonRpcError(INVALID_PARAMS, 'arguments must be { uri } naming a resource or folder this server holds');
    }
    let url: URL;
    try {
      url = new URL(params.delivery.url);
    } catch {
      throw new JsonRpcError(INVALID_PARAMS, 'delivery.url is not a URL');
    }
    if (url.protocol !== 'https:') throw new JsonRpcError(INVALID_PARAMS, 'delivery.url must be https');
    return { uri, url: params.delivery.url };
  }

  #serves(uri: string): boolean {
    return uri.startsWith(`${this.#options.root}/`) && parseTarget(uri.slice(this.#options.root.length)) !== undefined;
  }

  // A keyed hash of the key, so the id is stable across restarts and reveals nothing about it.
  async #subscriptionId(principal: string, url: string, uri: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.#options.subscriptionIdKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const canonical = JSON.stringify([principal, url, RESOURCE_UPDATED, { uri }]);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
    return `sub_${Array.from(mac.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
}

// The URI itself and every folder above it, up to its type's root.
function coveringTargets(uri: string, root: string): string[] {
  if (!uri.startsWith(`${root}/`)) return [uri];
  const segments = uri.slice(root.length + 1).split('/');
  return segments.map((_segment, index) => `${root}/${segments.slice(0, index + 1).join('/')}`);
}
