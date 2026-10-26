// Level 1: SEP-3415's own methods for one event type, `mcp.resource.updated`, as its Open
// Question 2 sketches it. A offers no replay, so every cursor is null. Subscriptions live in the
// table both levels share.
import { JsonRpcError } from '../json-rpc';
import {
  FORBIDDEN,
  NOT_FOUND,
  UNSUPPORTED,
  type EventOccurrence,
  type EventsListResult,
  type EventsSubscribeRequestParams,
  type EventsSubscribeResult,
  type EventsUnsubscribeRequestParams,
  type EventType,
} from '../events-types';
import { INVALID_PARAMS, type Result } from '../vendor/mcp-spec/2026-07-28/schema';
import { randomId, type Deliveries } from './deliveries';
import { coveringTargets, type SubscriptionKey, type Subscriptions } from './subscriptions';
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
  /** A's own URI, as `https://….workers.dev/server/A`. */
  root: string;
  deliveries: Deliveries;
  subscriptions: Subscriptions;
}

export class Events {
  readonly #options: EventsOptions;

  constructor(options: EventsOptions) {
    this.#options = options;
  }

  list(): EventsListResult {
    return { resultType: 'complete', events: [RESOURCE_UPDATED_TYPE] };
  }

  async subscribe(params: EventsSubscribeRequestParams, principal: string | undefined): Promise<EventsSubscribeResult> {
    const { subscriptions, deliveries } = this.#options;
    const key = this.#key(params, principal);
    const { secret } = params.delivery;
    subscriptions.requireDelivery(key.url, secret);
    subscriptions.requireUnderCap(key);
    const generation = subscriptions.generation;
    const id = await subscriptions.idFor([key.principal, key.url, RESOURCE_UPDATED, { uri: key.target }]);
    await deliveries.requireVerified(key.principal, key.url, secret, id);
    const refreshBefore = subscriptions.grant(params.ttlMs);
    subscriptions.write({ ...key, id, secret, form: null, expiresAt: refreshBefore }, generation);
    return { resultType: 'complete', id, refreshBefore, cursor: null, truncated: false };
  }

  unsubscribe(params: EventsUnsubscribeRequestParams, principal: string | undefined): Result {
    const key = this.#key(params, principal);
    this.#options.subscriptions.requireDelivery(key.url);
    const id = this.#options.subscriptions.remove(key);
    if (id === undefined) throw new JsonRpcError(NOT_FOUND, 'No such subscription', { kind: 'subscription' });
    // SEP-3415: unsubscribing stops webhook deliveries immediately, retries included.
    this.#options.deliveries.cancel(id);
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
    const body: EventOccurrence = { eventId: `evt_${version}`, name: RESOURCE_UPDATED, timestamp: new Date().toISOString(), data: { uri }, cursor: null };
    const text = JSON.stringify(body);
    for (const row of this.#options.subscriptions.covering(TARGET_KIND, coveringTargets(uri, this.#options.root))) {
      const webhookId = `msg_${randomId(24)}`;
      this.#options.deliveries.enqueue(webhookId, { url: row.url, secret: row.secret, subscriptionId: row.id, webhookId, body: text, until: row.expiresAt });
    }
  }

  #key(params: { name: string; arguments?: { [key: string]: unknown }; delivery: { url: string } }, principal: string | undefined): SubscriptionKey {
    if (!principal) throw new JsonRpcError(FORBIDDEN, 'Subscribing needs an authenticated principal');
    if (params.name !== RESOURCE_UPDATED) throw new JsonRpcError(NOT_FOUND, `No event type ${params.name}`, { kind: 'event' });
    const args = params.arguments ?? {};
    const extra = Object.keys(args).filter((key) => key !== 'uri');
    const uri = args.uri;
    if (typeof uri !== 'string' || extra.length > 0 || !this.#serves(uri)) {
      throw new JsonRpcError(INVALID_PARAMS, 'arguments must be { uri } naming an https resource or folder this server holds');
    }
    return { targetKind: TARGET_KIND, target: uri, principal, url: params.delivery.url };
  }

  #serves(uri: string): boolean {
    return uri.startsWith(`${this.#options.root}/`) && parseTarget(uri.slice(this.#options.root.length)) !== undefined;
  }
}
