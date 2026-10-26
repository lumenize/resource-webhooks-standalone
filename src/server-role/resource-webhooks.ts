// Level 2: this extension's own methods, `resources/webhooks/subscribe` and
// `resources/webhooks/unsubscribe`, for a `uri` naming one resource, and the `ResourceChange` each
// write delivers, as sep-notes.md's requirements say. Deliveries go through the webhook module
// level 1 uses, with one slot per subscription and URI, so a newer version replaces a pending one
// (R12), and subscriptions live in the table both levels share.
import { JsonRpcError } from '../json-rpc';
import { FORBIDDEN, NOT_FOUND, UNSUPPORTED } from '../events-types';
import type {
  ResourceChange,
  ResourceContents,
  ResourceWebhookForm,
  ResourceWebhooksSettings,
  ResourceWebhookSubscribeRequestParams,
  ResourceWebhookSubscribeResult,
  ResourceWebhookUnsubscribeRequestParams,
} from '../resource-webhooks-types';
import { INVALID_PARAMS, type Result } from '../vendor/mcp-spec/2026-07-28/schema';
import { randomId, type Deliveries } from './deliveries';
import { coveringTargets, type SubscriptionKey, type Subscriptions } from './subscriptions';
import { parseTarget } from './targets';
import type { VersionStore } from './version-store';

/** The forms A delivers, as its capability declares them. */
export const FORMS: readonly ResourceWebhookForm[] = ['notify', 'full'];

/** The largest body A sends in the `full` form, SEP-3415's delivery profile, past which it sends `notify` (R27). */
export const FULL_BODY_LIMIT = 256 * 1024;

const TARGET_KIND = 'uri';

export interface ResourceWebhooksOptions {
  /** A's own URI, as `https://….workers.dev/server/A`. */
  root: string;
  store: VersionStore;
  deliveries: Deliveries;
  subscriptions: Subscriptions;
  /** A resource's contents entry, as `resources/read` gives it, from its path and stored text. */
  contentsOf(path: string, text: string): ResourceContents;
}

export class ResourceWebhooks {
  readonly #options: ResourceWebhooksOptions;

  constructor(options: ResourceWebhooksOptions) {
    this.#options = options;
  }

  /** The settings A declares under the extension in `server/discover` (R1). */
  settings(): ResourceWebhooksSettings {
    return { forms: [...FORMS] };
  }

  async subscribe(params: ResourceWebhookSubscribeRequestParams, principal: string | undefined): Promise<ResourceWebhookSubscribeResult> {
    const { subscriptions, deliveries, store, contentsOf } = this.#options;
    const { key, path } = this.#key(params, principal);
    const form = declared('form', params.form);
    const catchUp = declared('catchUp', params.catchUp);
    const { secret } = params.delivery;
    subscriptions.requireDelivery(key.url, secret);
    subscriptions.requireUnderCap(key);
    const generation = subscriptions.generation;
    const id = await subscriptions.idFor([key.principal, key.url, key.targetKind, key.target]);
    await deliveries.requireVerified(key.principal, key.url, secret, id);

    // The handshake awaited a fetch, so the row is written and the version read in one
    // synchronous block, and a write that landed meanwhile is in the result.
    const refreshBefore = subscriptions.grant(params.ttlMs);
    subscriptions.write({ ...key, id, secret, form, expiresAt: refreshBefore }, generation);
    const state = store.state(path);
    const result: ResourceWebhookSubscribeResult = { resultType: 'complete', id, refreshBefore, version: state.version };
    if (state.deleted) return { ...result, deleted: true };
    if (catchUp === 'full' && params.version !== state.version) return { ...result, contents: [contentsOf(path, state.contents)] };
    return result;
  }

  unsubscribe(params: ResourceWebhookUnsubscribeRequestParams, principal: string | undefined): Result {
    const { key } = this.#key(params, principal);
    this.#options.subscriptions.requireDelivery(key.url);
    const id = this.#options.subscriptions.remove(key);
    if (id === undefined) throw new JsonRpcError(NOT_FOUND, 'No such subscription', { kind: 'subscription' });
    this.#options.deliveries.cancel(id);
    return { resultType: 'complete' };
  }

  /**
   * Delivers a write of `path` at `version` to every live subscription covering it, each in its
   * own form. A deletion goes in the `notify` form whatever the subscription's (R11).
   */
  notify(path: string, version: string, deleted: boolean): void {
    const { root, store, deliveries, subscriptions, contentsOf } = this.#options;
    const uri = `${root}${path}`;
    const notify: ResourceChange = deleted ? { uri, form: 'notify', version, deleted: true } : { uri, form: 'notify', version };
    let full: string | undefined;
    const bodyFor = (form: string | null): string => {
      if (deleted || form !== 'full') return JSON.stringify(notify);
      if (full === undefined) {
        const current = store.current(path) as { contents: string };
        const change: ResourceChange = { uri, form: 'full', version, contents: [contentsOf(path, current.contents)] };
        full = JSON.stringify(change);
        if (new TextEncoder().encode(full).length > FULL_BODY_LIMIT) full = JSON.stringify(notify);
      }
      return full;
    };
    for (const row of subscriptions.covering(TARGET_KIND, coveringTargets(uri, root))) {
      // A new message for each version, with its own webhook-id, kept across that version's retries (R14).
      const webhookId = `msg_${randomId(24)}`;
      deliveries.enqueue(`${row.id}\n${uri}`, { url: row.url, secret: row.secret, subscriptionId: row.id, webhookId, body: bodyFor(row.form), until: row.expiresAt });
    }
  }

  #key(params: { uri?: string; uriTemplate?: string; listed?: true; delivery: { url: string } }, principal: string | undefined): { key: SubscriptionKey; path: string } {
    if (!principal) throw new JsonRpcError(FORBIDDEN, 'Subscribing needs an authenticated principal');
    const targets = (['uri', 'uriTemplate', 'listed'] as const).filter((name) => params[name] !== undefined);
    if (targets.length !== 1) throw new JsonRpcError(INVALID_PARAMS, 'A subscription names exactly one of uri, uriTemplate and listed');
    if (params.uri === undefined) throw new JsonRpcError(UNSUPPORTED, 'A subscribes only to a uri naming one resource', { feature: 'target', value: targets[0] });
    const { root } = this.#options;
    const target = params.uri.startsWith(`${root}/`) ? parseTarget(params.uri.slice(root.length)) : undefined;
    // As resources/read refuses a URI A could never serve (R7).
    if (!target) throw new JsonRpcError(INVALID_PARAMS, 'Resource not found', { uri: params.uri });
    if (!target.resource) throw new JsonRpcError(UNSUPPORTED, 'A subscribes only to a uri naming one resource', { feature: 'target', value: 'collection' });
    return { key: { targetKind: TARGET_KIND, target: params.uri, principal, url: params.delivery.url }, path: target.path };
  }
}

// A form A declared, `notify` when none is named, or `Unsupported` naming the one it did not (R5, R7).
function declared(feature: 'form' | 'catchUp', value: ResourceWebhookForm | undefined): ResourceWebhookForm {
  const form = value ?? 'notify';
  if (!FORMS.includes(form)) throw new JsonRpcError(UNSUPPORTED, `A does not offer the ${form} form`, { feature, value: form });
  return form;
}
