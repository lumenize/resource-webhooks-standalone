// Level 2: this extension's own methods, `resources/webhooks/subscribe` and
// `resources/webhooks/unsubscribe`, and the `ResourceChange` each write delivers, as sep-notes.md's
// requirements say. A target is one resource, or a collection: a folder or a type's root named by
// `uri`, a `uriTemplate`, or `listed`. Deliveries go through the webhook module level 1 uses, with
// one slot per subscription and URI, so a newer version replaces a pending one (R12), and
// subscriptions live in the table both levels share.
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
import { diff, type JsonValue } from '../vendor/lumenize-merge-patch/merge-patch';
import { INVALID_PARAMS, type JSONValue, type Result } from '../vendor/mcp-spec/2026-07-28/schema';
import { randomId, type Deliveries } from './deliveries';
import { coveringTargets, type Subscription, type SubscriptionKey, type Subscriptions } from './subscriptions';
import { parseTarget } from './targets';
import { templateMatcher } from './uri-templates';
import type { Row, VersionStore } from './version-store';

/** The forms A delivers, as its capability declares them. */
export const FORMS: readonly ResourceWebhookForm[] = ['notify', 'full', 'patch'];

/** The largest body A sends in the `full` form, SEP-3415's delivery profile, past which it sends `notify` (R27). */
export const FULL_BODY_LIMIT = 256 * 1024;

/** What a subscription covers: one resource, or the paths of a collection's members. */
type Coverage = { kind: 'resource'; path: string } | { kind: 'collection'; covers: (path: string) => boolean };

export interface ResourceWebhooksOptions {
  /** A's own URI, as `https://….workers.dev/server/A`. */
  root: string;
  store: VersionStore;
  deliveries: Deliveries;
  subscriptions: Subscriptions;
  /** A resource's contents entry, as `resources/read` gives it, from its path and stored text. */
  contentsOf(path: string, text: string): ResourceContents;
  /** Whether `resources/list` lists the resource at a path, which a `listed` target covers (R20). */
  listed(path: string): boolean;
  /** How many changes one result carries at most, after which it sets `hasMore` (R35). */
  pageSize: number;
}

export class ResourceWebhooks {
  readonly #options: ResourceWebhooksOptions;

  constructor(options: ResourceWebhooksOptions) {
    if (!Number.isInteger(options.pageSize) || options.pageSize < 1) throw new RangeError(`The page size must be a positive integer, not ${options.pageSize}`);
    this.#options = options;
  }

  /** The settings A declares under the extension in `server/discover` (R1). */
  settings(): ResourceWebhooksSettings {
    return { forms: [...FORMS] };
  }

  async subscribe(params: ResourceWebhookSubscribeRequestParams, principal: string | undefined): Promise<ResourceWebhookSubscribeResult> {
    const { subscriptions, deliveries, store, contentsOf } = this.#options;
    const { key, coverage } = this.#key(params, principal);
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
    if (coverage.kind === 'collection') return { resultType: 'complete', id, refreshBefore, ...this.#catchUp(coverage.covers, params.cursor, catchUp) };
    const state = store.state(coverage.path);
    const result: ResourceWebhookSubscribeResult = { resultType: 'complete', id, refreshBefore, version: state.version };
    if (state.deleted) return { ...result, deleted: true };
    if (catchUp === 'notify' || params.version === state.version) return result;
    const after = contentsOf(coverage.path, state.contents);
    // A patch from the version the client names, when A still keeps it; the contents otherwise.
    const from = catchUp === 'patch' && params.version !== undefined ? store.at(coverage.path, params.version) : undefined;
    const patch = from && !from.deleted ? patchBetween(contentsOf(coverage.path, from.contents), after) : undefined;
    return patch !== undefined ? { ...result, fromVersion: params.version, mergePatch: patch } : { ...result, contents: [after] };
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
    for (const row of this.#covering(path, uri)) {
      // A new message for each version, with its own webhook-id, kept across that version's retries (R14).
      const webhookId = `msg_${randomId(24)}`;
      const slot = `${row.id}\n${uri}`;
      const patch = row.form === 'patch' && !deleted ? this.#patchFor(slot, path, uri, version) : undefined;
      const message = { url: row.url, secret: row.secret, subscriptionId: row.id, webhookId, until: row.expiresAt };
      deliveries.enqueue(slot, patch ? { ...message, body: patch.body, patchFrom: patch.from } : { ...message, body: bodyFor(row.form === 'patch' ? 'full' : row.form) });
    }
  }

  // A delivery's patch: from where the delivery it replaces started, while one waits in the queue,
  // since the receiver never got it, or else from the previous version (R43). Undefined when no
  // patch can start there, as for a created resource, and the delivery goes full.
  #patchFor(slot: string, path: string, uri: string, version: string): { body: string; from: string } | undefined {
    const { store, deliveries, contentsOf } = this.#options;
    const current = store.current(path) as { contents: string };
    const start = deliveries.startOf(slot);
    const from = start !== undefined ? store.at(path, start) : store.before(path, version);
    if (!from || from.deleted) return undefined;
    const patch = patchBetween(contentsOf(path, from.contents), contentsOf(path, current.contents));
    if (patch === undefined) return undefined;
    const change: ResourceChange = { uri, form: 'patch', version, fromVersion: from.version, mergePatch: patch };
    return { body: JSON.stringify(change), from: from.version };
  }

  // Every live or lapsed subscription covering a write at `path`: a uri naming it or a folder above
  // it, a template it matches, and a listed target if resources/list lists it.
  #covering(path: string, uri: string): Subscription[] {
    const { subscriptions, root, listed } = this.#options;
    return [
      ...subscriptions.covering('uri', coveringTargets(uri, root)),
      ...subscriptions.ofKind('uriTemplate').filter((row) => templateMatcher(row.target)?.(uri)),
      ...(listed(path) ? subscriptions.ofKind('listed') : []),
    ];
  }

  // A collection's changes after a cursor, or every member there is when none is named or A can no
  // longer serve the one named, a page at a time (R32 to R35). A cursor names an epoch and a stamp,
  // and a page of a listing adds the stamp the listing began at and the last path it listed.
  #catchUp(covers: (path: string) => boolean, cursor: string | undefined, form: ResourceWebhookForm) {
    const { store, pageSize } = this.#options;
    const epoch = store.epoch();
    const parsed = cursor === undefined ? undefined : parseCursor(cursor);
    if (cursor !== undefined && (parsed?.epoch !== epoch || (parsed.kind === 'changes' && !store.keepsEverythingAfter(parsed.stamp)))) {
      return this.#listing(covers, form, store.newestStamp(), '', true);
    }
    if (parsed === undefined) return this.#listing(covers, form, store.newestStamp(), '', false);
    if (parsed.kind !== 'changes') return this.#listing(covers, form, parsed.snapshot, parsed.after, parsed.kind === 'reset');
    const rows = store.changedAfter(parsed.stamp, covers, pageSize + 1);
    const page = rows.slice(0, pageSize);
    const hasMore = rows.length > pageSize;
    return {
      changes: page.map((row) => this.#change(row, form, parsed.stamp)),
      cursor: `c${epoch}.${hasMore ? page.at(-1)!.stamp : store.newestStamp()}`,
      ...(hasMore ? { hasMore: true as const } : {}),
    };
  }

  // Every live member after `after`, in path order. Its last page's cursor is the stamp the
  // listing began at, so a write between its pages comes in the next refresh.
  #listing(covers: (path: string) => boolean, form: ResourceWebhookForm, snapshot: number, after: string, reset: boolean) {
    const { store, pageSize } = this.#options;
    const rows = store.liveAfter(after, covers, pageSize + 1);
    const page = rows.slice(0, pageSize);
    const hasMore = rows.length > pageSize;
    const epoch = store.epoch();
    return {
      changes: page.map((row) => this.#change(row, form)),
      cursor: hasMore ? `${reset ? 'r' : 'l'}${epoch}.${snapshot}.${toBase64Url(page.at(-1)!.path)}` : `c${epoch}.${snapshot}`,
      ...(hasMore ? { hasMore: true as const } : {}),
      ...(reset ? { reset: true as const } : {}),
    };
  }

  // A member's change in a catch-up's form. A patch starts from the member's version at the
  // cursor, so a listing, which names none, and a member created since, carry the contents (R44).
  #change(row: Row, form: ResourceWebhookForm, cursorStamp?: number): ResourceChange {
    const { root, store, contentsOf } = this.#options;
    const uri = `${root}${row.path}`;
    if (row.deleted) return { uri, form: 'notify', version: row.version, deleted: true };
    if (form === 'notify') return { uri, form: 'notify', version: row.version };
    const after = contentsOf(row.path, row.contents);
    const from = form === 'patch' && cursorStamp !== undefined ? store.asOf(row.path, cursorStamp) : undefined;
    const patch = from && !from.deleted ? patchBetween(contentsOf(row.path, from.contents), after) : undefined;
    if (patch !== undefined) return { uri, form: 'patch', version: row.version, fromVersion: from!.version, mergePatch: patch };
    return { uri, form: 'full', version: row.version, contents: [after] };
  }

  #key(params: { uri?: string; uriTemplate?: string; listed?: true; delivery: { url: string } }, principal: string | undefined): { key: SubscriptionKey; coverage: Coverage } {
    if (!principal) throw new JsonRpcError(FORBIDDEN, 'Subscribing needs an authenticated principal');
    const targets = (['uri', 'uriTemplate', 'listed'] as const).filter((name) => params[name] !== undefined);
    if (targets.length !== 1) throw new JsonRpcError(INVALID_PARAMS, 'A subscription names exactly one of uri, uriTemplate and listed');
    const url = params.delivery.url;
    if (params.uriTemplate !== undefined) {
      const matcher = templateMatcher(params.uriTemplate);
      if (!matcher) throw new JsonRpcError(UNSUPPORTED, 'A matches a template only by {name} and {+name}', { feature: 'uriTemplate', value: params.uriTemplate });
      const { root } = this.#options;
      return { key: { targetKind: 'uriTemplate', target: params.uriTemplate, principal, url }, coverage: { kind: 'collection', covers: (path) => matcher(`${root}${path}`) } };
    }
    if (params.listed !== undefined) {
      return { key: { targetKind: 'listed', target: '', principal, url }, coverage: { kind: 'collection', covers: (path) => this.#options.listed(path) } };
    }
    const { root } = this.#options;
    const uri = params.uri!;
    const target = uri.startsWith(`${root}/`) ? parseTarget(uri.slice(root.length)) : undefined;
    // As resources/read refuses a URI A could never serve (R7).
    if (!target) throw new JsonRpcError(INVALID_PARAMS, 'Resource not found', { uri });
    const key = { targetKind: 'uri', target: uri, principal, url };
    // A folder or a type's root is a collection, whatever its number of members (R38).
    if (!target.resource) return { key, coverage: { kind: 'collection', covers: (path) => path.startsWith(`${target.path}/`) } };
    return { key, coverage: { kind: 'resource', path: target.path } };
  }
}

type Cursor = { kind: 'changes'; epoch: number; stamp: number } | { kind: 'listing' | 'reset'; epoch: number; snapshot: number; after: string };

// A cursor this A wrote, or undefined for anything else, which the caller answers with a reset.
function parseCursor(cursor: string): Cursor | undefined {
  const changes = /^c(\d+)\.(\d+)$/.exec(cursor);
  if (changes) return { kind: 'changes', epoch: Number(changes[1]), stamp: Number(changes[2]) };
  const listing = /^([lr])(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(cursor);
  if (!listing) return undefined;
  const after = fromBase64Url(listing[4]);
  if (after === undefined) return undefined;
  return { kind: listing[1] === 'r' ? 'reset' : 'listing', epoch: Number(listing[2]), snapshot: Number(listing[3]), after };
}

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/**
 * The merge patch from one version's contents to another's, for a resource whose contents are one
 * JSON text entry, or undefined when the change must go whole: other contents, or a value no patch
 * can reach, as one holding a `null` member (R42).
 */
export function patchBetween(before: ResourceContents, after: ResourceContents): JSONValue | undefined {
  const parsed = [before, after].map(jsonOf);
  if (parsed.some((value) => value === undefined)) return undefined;
  const found = diff(parsed[0]!, parsed[1]!);
  if (found.kind === 'full') return undefined;
  return found.kind === 'same' ? {} : found.patch;
}

function jsonOf(entry: ResourceContents): JsonValue | undefined {
  if (entry.mimeType !== 'application/json' || !('text' in entry)) return undefined;
  try {
    return JSON.parse(entry.text) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * A form the server declared, `notify` when none is named, or `Unsupported` naming the one it did
 * not (R5, R7). A declares every form, so only a server declaring fewer reaches the refusal.
 */
export function declared(feature: 'form' | 'catchUp', value: ResourceWebhookForm | undefined, forms: readonly ResourceWebhookForm[] = FORMS): ResourceWebhookForm {
  const form = value ?? 'notify';
  if (!forms.includes(form)) throw new JsonRpcError(UNSUPPORTED, `The server does not offer the ${form} form`, { feature, value: form });
  return form;
}
