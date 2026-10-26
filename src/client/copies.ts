// What a level 2 subscriber holds of each resource it watches: the version, whether that version
// deleted it, and the contents when a delivery or a result carried them. It subscribes to one
// resource or to a collection, a folder by `uri`, a `uriTemplate` or `listed`, and for a collection
// keeps the cursor of its last result, takes every page of a catch-up, and drops on a reset's last
// page what no page of the reset listed (R32 to R35). It drops a delivery whose webhook-id it has
// seen or that none of its subscriptions covers, ignores one naming the version it holds (R15),
// and refreshes again when a delivery arrives while a refresh of the same subscription is
// outstanding (R41), since the two travel apart and either may arrive first. It runs one refresh
// of a subscription at a time, so a reset's pages and a crossing belong to the subscription, not
// to whichever call is out. It applies a merge patch only to the version the patch starts from,
// and otherwise refreshes one resource or reads a collection's member again, which needs `read`
// (R45). Besides types
// it imports only the copied merge patch, by its `.ts` path, so Node runs it with types stripped.
import type { ResourceChange, ResourceContents, ResourceWebhookSubscribeResult } from '../resource-webhooks-types';
import { applyMergePatch, type JsonValue } from '../vendor/lumenize-merge-patch/merge-patch.ts';

export interface Copy {
  version: string;
  deleted: boolean;
  /** The contents at `version`, when a delivery or a result carried them. */
  contents?: ResourceContents[];
}

/** What a subscription covers, as the subscribe request names it. */
export type Target = { uri: string } | { uriTemplate: string } | { listed: true };

/** What a refresh names: for one resource the version held, for a collection the last cursor. */
export interface Held {
  version?: string;
  cursor?: string;
}

/** Subscribes to a target or refreshes it. */
export type Refresh = (target: Target, held: Held) => Promise<ResourceWebhookSubscribeResult>;

/** Reads one resource again, by `resources/read` or `GET`, at whatever version it has now. */
export type Read = (uri: string) => Promise<Copy>;

export interface CopiesOptions {
  /** Reads a collection's member again when a patch for it starts from a version not held. */
  read?: Read;
  /**
   * Told of a refresh or a read that `Copies` made by itself, for a patch it could not apply, and
   * that failed. Without it, the failure is left unhandled, so it is not lost.
   */
  onError?: (error: unknown) => void;
}

interface Subscribed {
  target: Target;
  /** The id its results carry, unknown until the first arrives. */
  id?: string;
  /** Whether its results are a collection's, as its first result says (R38). */
  collection: boolean;
  cursor?: string;
  /** The members it has brought, so a reset can drop the ones it no longer lists. */
  members: Set<string>;
  /**
   * What the pages of a reset still in progress have listed. It lives beside the cursor, since a
   * refresh that fails partway leaves the next to finish the reset.
   */
  resetListed?: Set<string>;
  /** The refresh out now, if any, and whether a delivery crossed it. */
  outstanding?: { crossed: boolean };
  /** The last refresh queued, which the next waits for. */
  queue: Promise<void>;
}

// How many webhook-ids it remembers, enough to cover a delivery's retries.
const SEEN = 1000;

export class Copies {
  readonly #refresh: Refresh;
  readonly #read?: Read;
  readonly #onError: (error: unknown) => void;
  readonly #copies = new Map<string, Copy>();
  readonly #subscriptions = new Map<string, Subscribed>();
  // Each subscription by the id its results and its deliveries carry.
  readonly #byId = new Map<string, Subscribed>();
  readonly #seen = new Set<string>();
  // Each member being read again, and whether a delivery for it arrived meanwhile.
  readonly #reading = new Map<string, { crossed: boolean }>();

  constructor(refresh: Refresh, { read, onError }: CopiesOptions = {}) {
    this.#refresh = refresh;
    this.#read = read;
    this.#onError =
      onError ??
      ((error) => {
        throw error;
      });
  }

  get(uri: string): Copy | undefined {
    return this.#copies.get(uri);
  }

  /** Each subscription it has made, with the id and cursor of its last result. */
  subscriptions(): { target: Target; id?: string; cursor?: string }[] {
    return [...this.#subscriptions.values()].map(({ target, id, cursor }) => ({ target, ...(id ? { id } : {}), ...(cursor ? { cursor } : {}) }));
  }

  /** The URIs of everything held that is not deleted, in no order. */
  held(): string[] {
    return [...this.#copies].filter(([, copy]) => !copy.deleted).map(([uri]) => uri);
  }

  /**
   * Takes a change a delivery carried, unless it is a repeat, uncovered, or the version held. B
   * passes on the subscription id each delivery came under, and a change is covered when it came
   * under a subscription held, or when a held `uri` target names it or a folder above it, which
   * is how one with no id, or one that beats its subscription's first result, is told.
   */
  deliver(change: ResourceChange, { webhookId, subscriptionId }: { webhookId?: string; subscriptionId?: string } = {}): void {
    if (webhookId !== undefined) {
      if (this.#seen.has(webhookId)) return;
      this.#seen.add(webhookId);
      if (this.#seen.size > SEEN) this.#seen.delete(this.#seen.values().next().value!);
    }
    let subscribed = subscriptionId !== undefined ? this.#byId.get(subscriptionId) : this.#underUri(change.uri);
    if (!subscribed && subscriptionId !== undefined) {
      // A delivery can beat the first result, which brings the id, so every first refresh still
      // out has crossed it, and the change is taken if a held `uri` target covers it.
      for (const waiting of this.#subscriptions.values()) if (waiting.id === undefined && waiting.outstanding) waiting.outstanding.crossed = true;
      subscribed = this.#underUri(change.uri);
    }
    if (!subscribed) return;
    if ('uri' in subscribed.target && change.uri !== subscribed.target.uri && !change.uri.startsWith(`${subscribed.target.uri}/`)) return;
    if (subscribed.outstanding) subscribed.outstanding.crossed = true;
    const reading = this.#reading.get(change.uri);
    if (reading) reading.crossed = true;
    if (subscribed.collection) subscribed.members.add(change.uri);
    this.#takeChange(change, subscribed);
  }

  /**
   * Subscribes or refreshes, naming the version or cursor held, through every page, once any
   * refresh of the same subscription already queued has finished. For one resource, a result a
   * delivery crossed may be older than what the delivery brought, so it is not taken, and the
   * refresh is made again. A collection's pages are taken, since their cursor must be kept, and
   * the refresh made again from it, which returns anything the crossing changed.
   */
  refresh(target: Target): Promise<void> {
    const key = keyOf(target);
    const subscribed: Subscribed = this.#subscriptions.get(key) ?? { target, collection: false, members: new Set<string>(), queue: Promise.resolve() };
    this.#subscriptions.set(key, subscribed);
    const run = subscribed.queue.then(() => this.#refreshUncrossed(subscribed));
    subscribed.queue = run.catch(() => undefined);
    return run;
  }

  async #refreshUncrossed(subscribed: Subscribed): Promise<void> {
    const { target } = subscribed;
    const uri = 'uri' in target ? target.uri : undefined;
    // A refresh names the version held, unless a patch from it could not be applied, as for a
    // version held without its contents, when the next names none and gets the contents.
    let nameVersion = true;
    for (;;) {
      const outstanding = { crossed: false };
      subscribed.outstanding = outstanding;
      try {
        for (let more = true; more; ) {
          const held: Held = subscribed.collection ? { cursor: subscribed.cursor } : { version: uri === undefined || !nameVersion ? undefined : this.#copies.get(uri)?.version };
          const result = await this.#refresh(target, held);
          subscribed.id = result.id;
          this.#byId.set(result.id, subscribed);
          if (result.cursor === undefined) {
            if (!outstanding.crossed && uri !== undefined && !this.#takeResult(uri, result)) {
              nameVersion = false;
              outstanding.crossed = true;
            }
            break;
          }
          subscribed.collection = true;
          if (result.reset) subscribed.resetListed ??= new Set();
          else subscribed.resetListed = undefined;
          for (const change of result.changes ?? []) {
            subscribed.members.add(change.uri);
            subscribed.resetListed?.add(change.uri);
            this.#takeChange(change, subscribed);
          }
          subscribed.cursor = result.cursor;
          more = result.hasMore === true;
          // A reset lists every member there is, so at its last page one held and no page listed
          // is gone (R34).
          if (subscribed.resetListed && !more) {
            for (const member of subscribed.members) {
              if (subscribed.resetListed.has(member)) continue;
              subscribed.members.delete(member);
              this.#copies.delete(member);
            }
            subscribed.resetListed = undefined;
          }
        }
      } finally {
        subscribed.outstanding = undefined;
      }
      if (!outstanding.crossed) return;
    }
  }

  #underUri(uri: string): Subscribed | undefined {
    for (const subscribed of this.#subscriptions.values()) {
      if ('uri' in subscribed.target && (uri === subscribed.target.uri || uri.startsWith(`${subscribed.target.uri}/`))) return subscribed;
    }
    return undefined;
  }

  #takeChange(change: ResourceChange, subscribed: Subscribed): void {
    const held = this.#copies.get(change.uri);
    if (held?.version === change.version) return;
    if (change.form === 'patch') {
      const copy = patched(held, change.fromVersion, change.version, change.mergePatch);
      if (copy) this.#copies.set(change.uri, copy);
      // Deliveries may have moved b past the cursor's version, so a member is read again rather
      // than caught up by the cursor, and one resource is refreshed, naming the version held.
      else if (!subscribed.collection) this.refresh(subscribed.target).catch(this.#onError);
      else if (this.#read) this.#readAgain(change.uri).catch(this.#onError);
      else throw new Error(`Copies needs \`read\` to read ${change.uri} again, since its patch starts from a version not held`);
      return;
    }
    const deleted = change.form === 'notify' && change.deleted === true;
    this.#copies.set(change.uri, { version: change.version, deleted, ...(change.form === 'full' ? { contents: change.contents } : {}) });
  }

  // Whether the result was taken, or held no news. A patch from a version not held is not taken.
  #takeResult(uri: string, result: ResourceWebhookSubscribeResult): boolean {
    if (result.version === undefined) return true;
    const held = this.#copies.get(uri);
    if (result.mergePatch !== undefined) {
      const copy = patched(held, result.fromVersion, result.version, result.mergePatch);
      if (copy) this.#copies.set(uri, copy);
      return copy !== undefined;
    }
    // The same version with no contents is no news, and keeps the contents already held.
    if (held?.version === result.version && !result.contents) return true;
    this.#copies.set(uri, { version: result.version, deleted: result.deleted === true, ...(result.contents ? { contents: result.contents } : {}) });
    return true;
  }

  // Reads a member again, once at a time, and again if a delivery for it arrived meanwhile, since
  // the two travel apart as a refresh and a delivery do (R41).
  async #readAgain(uri: string): Promise<void> {
    if (this.#reading.has(uri)) return;
    const reading = { crossed: false };
    this.#reading.set(uri, reading);
    try {
      for (;;) {
        reading.crossed = false;
        const copy = await this.#read!(uri);
        if (reading.crossed) continue;
        this.#copies.set(uri, copy);
        return;
      }
    } finally {
      this.#reading.delete(uri);
    }
  }
}

// The copy a merge patch makes of the one held, if it holds the version the patch starts from, as
// one JSON text entry. Undefined otherwise, since a patch applies to nothing else (R45).
function patched(held: Copy | undefined, fromVersion: string | undefined, version: string, mergePatch: unknown): Copy | undefined {
  if (!held || held.deleted || held.version !== fromVersion || held.contents?.length !== 1) return undefined;
  const [entry] = held.contents;
  if (entry.mimeType !== 'application/json' || !('text' in entry)) return undefined;
  let value: JsonValue;
  try {
    value = JSON.parse(entry.text) as JsonValue;
  } catch {
    return undefined;
  }
  // The entry's `_meta` named the version patched from, so the patched entry carries none.
  const { _meta: _old, ...rest } = entry;
  return { version, deleted: false, contents: [{ ...rest, text: JSON.stringify(applyMergePatch(value, mergePatch as JsonValue)) }] };
}

function keyOf(target: Target): string {
  if ('uri' in target) return `uri ${target.uri}`;
  if ('uriTemplate' in target) return `uriTemplate ${target.uriTemplate}`;
  return 'listed';
}
