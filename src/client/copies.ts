// What a level 2 subscriber holds of each resource it watches: the version, whether that version
// deleted it, and the contents when a delivery or a result carried them. It ignores a delivery of
// a version it holds (R15), and refreshes again when a delivery arrives while a refresh naming the
// same resource is outstanding (R41), since the result and the delivery travel apart and either
// may arrive first. Like mcp-client.ts it imports nothing but types.
import type { ResourceChange, ResourceContents, ResourceWebhookSubscribeResult } from '../resource-webhooks-types';

export interface Copy {
  version: string;
  deleted: boolean;
  /** The contents at `version`, when a delivery or a result carried them. */
  contents?: ResourceContents[];
}

/** Subscribes to `uri` or refreshes it, naming the version held, if any. */
export type Refresh = (uri: string, version: string | undefined) => Promise<ResourceWebhookSubscribeResult>;

export class Copies {
  readonly #refresh: Refresh;
  readonly #copies = new Map<string, Copy>();
  // Each resource's outstanding refresh, and whether a delivery crossed it.
  readonly #refreshing = new Map<string, { crossed: boolean }>();

  constructor(refresh: Refresh) {
    this.#refresh = refresh;
  }

  get(uri: string): Copy | undefined {
    return this.#copies.get(uri);
  }

  /** Takes a change a delivery carried, unless it names the version held. */
  deliver(change: ResourceChange): void {
    const outstanding = this.#refreshing.get(change.uri);
    if (outstanding) outstanding.crossed = true;
    if (this.#copies.get(change.uri)?.version === change.version) return;
    const deleted = change.form === 'notify' && change.deleted === true;
    this.#copies.set(change.uri, { version: change.version, deleted, ...(change.form === 'full' ? { contents: change.contents } : {}) });
  }

  /** Subscribes or refreshes, naming the version held, and again while a delivery crosses it. */
  async refresh(uri: string): Promise<Copy | undefined> {
    for (;;) {
      const outstanding = { crossed: false };
      this.#refreshing.set(uri, outstanding);
      try {
        this.#take(uri, await this.#refresh(uri, this.#copies.get(uri)?.version));
      } finally {
        this.#refreshing.delete(uri);
      }
      if (!outstanding.crossed) return this.#copies.get(uri);
    }
  }

  #take(uri: string, result: ResourceWebhookSubscribeResult): void {
    if (result.version === undefined) return;
    const held = this.#copies.get(uri);
    // The same version with no contents is no news, and keeps the contents already held.
    if (held?.version === result.version && !result.contents) return;
    this.#copies.set(uri, { version: result.version, deleted: result.deleted === true, ...(result.contents ? { contents: result.contents } : {}) });
  }
}
