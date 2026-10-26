// The resource webhooks extension's types, as sep-notes.md's requirements define them, written in
// the style of the spec's schema.ts. `npm run generate:schema` writes their JSON Schema to
// resource-webhooks-types.schema.json.
import type { WebhookDeliveryStatus } from './events-types';
import type {
  BlobResourceContents,
  JSONRPCRequest,
  JSONValue,
  RequestParams,
  Result,
  TextResourceContents,
} from './vendor/mcp-spec/2026-07-28/schema';

/** The extension's identifier, a key in `capabilities.extensions`. */
export const RESOURCE_WEBHOOKS_EXTENSION = 'io.modelcontextprotocol/resource-webhooks';

/**
 * How a delivery or a result carries a change: `notify` names the version only, `full` adds the
 * contents, and `patch` a merge patch from a version the client holds.
 */
export type ResourceWebhookForm = 'notify' | 'full' | 'patch';

/** The extension's settings, under `capabilities.extensions`. */
export interface ResourceWebhooksSettings {
  /** The forms the server delivers. `notify` is always among them. */
  forms: ResourceWebhookForm[];
}

/**
 * What a subscription covers: a resource and all under it, each match of a template and all
 * under it, or every resource `resources/list` returns.
 */
export type SubscriptionTarget = { uri: string } | { uriTemplate: string } | { listed: true };

/** A resource's contents, as `resources/read` returns them. */
export type ResourceContents = TextResourceContents | BlobResourceContents;

export type ResourceWebhookSubscribeRequestParams = RequestParams &
  SubscriptionTarget & {
    /** The deliveries' form, `notify` if omitted. */
    form?: ResourceWebhookForm;
    /** This result's form, `notify` if omitted. */
    catchUp?: ResourceWebhookForm;
    /** For one resource, the version the client holds. */
    version?: string;
    /** For a collection, the last result's cursor. */
    cursor?: string;
    delivery: { url: string; secret: string };
    /** The suggested lifetime in milliseconds, as SEP-3415's `events/subscribe` takes it. */
    ttlMs?: number | null;
  };

export interface ResourceWebhookSubscribeRequest extends JSONRPCRequest {
  method: 'resources/webhooks/subscribe';
  params: ResourceWebhookSubscribeRequestParams;
}

export interface ResourceWebhookSubscribeResult extends Result {
  /** Derived from the subscription key, and carried in `X-MCP-Subscription-Id` on every delivery. */
  id: string;
  /** When the grant ends, or `null` for no expiry. */
  refreshBefore: string | null;
  /** For one resource, its current version. */
  version?: string;
  /** That version deleted the resource. */
  deleted?: true;
  /** For one resource, when `catchUp` is `full` and the client's version differs. */
  contents?: ResourceContents[];
  /** For one resource, when `catchUp` is `patch`: the version the patch starts from, the client's. */
  fromVersion?: string;
  /** For one resource, when `catchUp` is `patch`: an RFC 7396 merge patch from `fromVersion` to `version`. */
  mergePatch?: JSONValue;
  /** For a collection, each member changed since the cursor, at its newest version. */
  changes?: ResourceChange[];
  /** For a collection, where this result stops. */
  cursor?: string;
  /** For a collection, more changes: refresh again with the cursor. */
  hasMore?: true;
  /** For a collection, `changes` lists every member there is. */
  reset?: true;
  /** As SEP-3415 defines it. */
  deliveryStatus?: WebhookDeliveryStatus;
}

export type ResourceWebhookUnsubscribeRequestParams = RequestParams &
  SubscriptionTarget & {
    delivery: { url: string };
  };

export interface ResourceWebhookUnsubscribeRequest extends JSONRPCRequest {
  method: 'resources/webhooks/unsubscribe';
  params: ResourceWebhookUnsubscribeRequestParams;
}

/** What a webhook delivery carries: one version of one resource. */
export type ResourceChange = { uri: string } & (
  | { form: 'notify'; version: string; deleted?: true }
  | { form: 'full'; version: string; contents: ResourceContents[] }
  | {
      form: 'patch';
      version: string;
      /** The version the patch starts from, which a client applies it to only if it holds it. */
      fromVersion: string;
      /** An RFC 7396 merge patch of the resource's one JSON text entry, parsed. */
      mergePatch: JSONValue;
    }
);
