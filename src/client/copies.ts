// What a level 2 subscriber holds of each resource it watches: the version, whether that version
// deleted it, and the contents when a delivery or a result carried them. It drops a delivery whose
// webhook-id it has seen, or whose resource none of its targets covers, ignores one naming the
// version it holds (R15), and asks again when a delivery arrives while a refresh naming the same
// resource is outstanding (R41), since the result and the delivery travel apart and either may
// arrive first. Like mcp-client.ts it imports nothing but types.
import type { ResourceChange, ResourceContents, ResourceWebhookSubscribeResult } from '../resource-webhooks-types';

export interface Copy {
  version: string;
  deleted: boolean;
  /** The contents at `version`, when a delivery or a result carried them. */
  contents?: ResourceContents[];
}

/** Subscribes to `uri` or refreshes it, naming the version held, if any. */
export type Refresh = (uri: string, version: string | undefined) => Promise<ResourceWebhookSubscribeResult>;

// How many webhook-ids it remembers, enough to cover a delivery's retries.
const SEEN = 1000;

export class Copies {
  readonly #refresh: Refresh;
  readonly #copies = new Map<string, Copy>();
  // The resources it has subscribed to, whose deliveries it takes.
  readonly #targets = new Set<string>();
  // Each resource's outstanding refreshes, and whether a delivery crossed each.
  readonly #refreshing = new Map<string, Set<{ crossed: boolean }>>();
  readonly #seen = new Set<string>();

  constructor(refresh: Refresh) {
    this.#refresh = refresh;
  }

  get(uri: string): Copy | undefined {
    return this.#copies.get(uri);
  }

  /** Takes a change a delivery carried, unless it is a repeat, uncovered, or the version held. */
  deliver(change: ResourceChange, webhookId?: string): void {
    if (webhookId !== undefined) {
      if (this.#seen.has(webhookId)) return;
      this.#seen.add(webhookId);
      if (this.#seen.size > SEEN) this.#seen.delete(this.#seen.values().next().value!);
    }
    if (!this.#covers(change.uri)) return;
    for (const outstanding of this.#refreshing.get(change.uri) ?? []) outstanding.crossed = true;
    if (this.#copies.get(change.uri)?.version === change.version) return;
    const deleted = change.form === 'notify' && change.deleted === true;
    this.#copies.set(change.uri, { version: change.version, deleted, ...(change.form === 'full' ? { contents: change.contents } : {}) });
  }

  /**
   * Subscribes or refreshes, naming the version held. A result that a delivery crossed may be
   * older than what the delivery brought, so it is not taken, and the refresh is made again.
   */
  async refresh(uri: string): Promise<Copy | undefined> {
    this.#targets.add(uri);
    for (;;) {
      const outstanding = { crossed: false };
      const trackers = this.#refreshing.get(uri) ?? new Set();
      this.#refreshing.set(uri, trackers.add(outstanding));
      let result: ResourceWebhookSubscribeResult;
      try {
        result = await this.#refresh(uri, this.#copies.get(uri)?.version);
      } finally {
        trackers.delete(outstanding);
        if (trackers.size === 0) this.#refreshing.delete(uri);
      }
      if (!outstanding.crossed) {
        this.#take(uri, result);
        return this.#copies.get(uri);
      }
    }
  }

  #covers(uri: string): boolean {
    for (const target of this.#targets) if (uri === target || uri.startsWith(`${target}/`)) return true;
    return false;
  }

  #take(uri: string, result: ResourceWebhookSubscribeResult): void {
    if (result.version === undefined) return;
    const held = this.#copies.get(uri);
    // The same version with no contents is no news, and keeps the contents already held.
    if (held?.version === result.version && !result.contents) return;
    this.#copies.set(uri, { version: result.version, deleted: result.deleted === true, ...(result.contents ? { contents: result.contents } : {}) });
  }
}
