// Every subscription A holds, level 1's and level 2's, in one table keyed by what it listens for,
// who asked and where it delivers, so a write finds the ones covering its URI by the key, and one
// principal's cap counts both levels. Each level checks its own target, and this module the
// delivery, the cap, the grant and the write after a handshake.
import { JsonRpcError } from '../json-rpc';
import { FORBIDDEN, RESOURCE_EXHAUSTED } from '../events-types';
import { secretBytes } from '../standard-webhooks';
import { INVALID_PARAMS } from '../vendor/mcp-spec/2026-07-28/schema';

export interface SubscriptionsOptions {
  /** Keys the hash a subscription's id is derived by, a secret of its own. */
  subscriptionIdKey: string;
  /** The longest lifetime A grants, and the one it grants when asked for none or for no expiry. */
  maxTtlMs: number;
  /** How many subscriptions one principal may hold, across both levels. */
  subscriptionCap: number;
}

/** What identifies a subscription: its kind of target and the target, the principal and the URL. */
export interface SubscriptionKey {
  /** As `event:mcp.resource.updated` for level 1, or `uri` for level 2. */
  targetKind: string;
  target: string;
  principal: string;
  url: string;
}

export interface Subscription extends SubscriptionKey {
  id: string;
  secret: string;
  /** Level 2's form, `notify` or `full`, and null for level 1. */
  form: string | null;
  expiresAt: string;
}

export class Subscriptions {
  readonly #sql: SqlStorage;
  readonly #options: SubscriptionsOptions;
  // Raised by each Wipe, so a subscribe that waited out one on its handshake writes nothing.
  #generation = 0;

  constructor(sql: SqlStorage, options: SubscriptionsOptions) {
    this.#sql = sql;
    this.#options = options;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS Subscriptions (
        targetKind TEXT NOT NULL,
        target TEXT NOT NULL,
        principal TEXT NOT NULL,
        url TEXT NOT NULL,
        id TEXT NOT NULL,
        secret TEXT NOT NULL,
        form TEXT,
        expiresAt TEXT NOT NULL,
        PRIMARY KEY (targetKind, target, principal, url)
      ) WITHOUT ROWID;
    `);
    // A table made before level 2 has no form column.
    const columns = sql.exec<{ name: string }>('PRAGMA table_info(Subscriptions)').toArray();
    if (!columns.some((column) => column.name === 'form')) sql.exec('ALTER TABLE Subscriptions ADD COLUMN form TEXT');
    // Expired subscriptions are swept when A wakes, and skipped lazily at delivery.
    sql.exec('DELETE FROM Subscriptions WHERE expiresAt < ?', new Date().toISOString());
  }

  /** Changes at each Wipe, so a caller that awaited a handshake can tell one happened. */
  get generation(): number {
    return this.#generation;
  }

  /** Throws `InvalidParams` for a delivery URL that is not `https` or a secret SEP-3415 refuses. */
  requireDelivery(url: string, secret?: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new JsonRpcError(INVALID_PARAMS, 'delivery.url is not a URL');
    }
    if (parsed.protocol !== 'https:') throw new JsonRpcError(INVALID_PARAMS, 'delivery.url must be https');
    if (secret !== undefined && !secretBytes(secret)) throw new JsonRpcError(INVALID_PARAMS, 'delivery.secret must be whsec_ and the base64 of 24 to 64 bytes');
  }

  /** Throws `ResourceExhausted` when the principal holds the cap, not counting the key's own. */
  requireUnderCap(key: SubscriptionKey): void {
    const held = this.#sql
      .exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM Subscriptions WHERE principal = ? AND NOT (targetKind = ? AND target = ? AND url = ?)',
        key.principal,
        key.targetKind,
        key.target,
        key.url,
      )
      .one().count;
    if (held >= this.#options.subscriptionCap) {
      throw new JsonRpcError(RESOURCE_EXHAUSTED, 'Too many subscriptions', { limit: 'subscriptions', max: this.#options.subscriptionCap });
    }
  }

  /** The id of the subscription a key's canonical form names. */
  idFor(canonical: unknown[]): Promise<string> {
    return subscriptionId(this.#options.subscriptionIdKey, canonical);
  }

  /** When a grant for the suggested lifetime ends. A grants no subscription without an end. */
  grant(ttlMs: number | null | undefined): string {
    const ttl = typeof ttlMs === 'number' ? Math.min(Math.max(ttlMs, 0), this.#options.maxTtlMs) : this.#options.maxTtlMs;
    return new Date(Date.now() + ttl).toISOString();
  }

  /**
   * Writes the subscription, or refreshes it, replacing its secret, form and grant. A handshake
   * awaited a fetch before this, which let other requests in, a Wipe or this principal's other
   * subscribes among them, so it checks both again, and writes, in one synchronous step.
   */
  write(subscription: Subscription, generation: number): void {
    if (generation !== this.#generation) throw new JsonRpcError(FORBIDDEN, 'The server was wiped while this subscribe waited for its handshake');
    this.requireUnderCap(subscription);
    this.#sql.exec(
      'INSERT OR REPLACE INTO Subscriptions (targetKind, target, principal, url, id, secret, form, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      subscription.targetKind,
      subscription.target,
      subscription.principal,
      subscription.url,
      subscription.id,
      subscription.secret,
      subscription.form,
      subscription.expiresAt,
    );
  }

  /** Removes a subscription, and answers its id, or undefined when the key matches none. */
  remove(key: SubscriptionKey): string | undefined {
    const removed = this.#sql
      .exec<{ id: string }>(
        'DELETE FROM Subscriptions WHERE targetKind = ? AND target = ? AND principal = ? AND url = ? RETURNING id',
        key.targetKind,
        key.target,
        key.principal,
        key.url,
      )
      .toArray();
    return removed[0]?.id;
  }

  /** The unexpired subscriptions of one kind whose target is one of `targets`. */
  covering(targetKind: string, targets: string[]): Subscription[] {
    const now = new Date().toISOString();
    return targets.flatMap((target) =>
      this.#sql
        .exec<Subscription & Record<string, SqlStorageValue>>(
          'SELECT targetKind, target, principal, url, id, secret, form, expiresAt FROM Subscriptions WHERE targetKind = ? AND target = ? AND expiresAt >= ?',
          targetKind,
          target,
          now,
        )
        .toArray(),
    );
  }

  /** Forgets every subscription, as a Wipe does. */
  clear(): void {
    this.#generation++;
    this.#sql.exec('DELETE FROM Subscriptions');
  }
}

/**
 * A keyed hash of a subscription key's canonical form, so the id is stable across restarts and a
 * logged one cannot confirm a guessed key (R25).
 */
export async function subscriptionId(idKey: string, canonical: unknown[]): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(idKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(canonical))));
  return `sub_${Array.from(mac.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** A URI and every folder above it, up to its type's root, as the targets that cover it. */
export function coveringTargets(uri: string, root: string): string[] {
  if (!uri.startsWith(`${root}/`)) return [uri];
  const segments = uri.slice(root.length + 1).split('/');
  return segments.map((_segment, index) => `${root}/${segments.slice(0, index + 1).join('/')}`);
}
