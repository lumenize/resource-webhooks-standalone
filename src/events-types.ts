// The Events extension's types, as SEP-3415 at commit b0efd11 defines them in prose, written in
// the style of the spec's schema.ts, since the SEP ships no TypeScript. Only what level 1 uses
// is here. `npm run generate:schema` writes their JSON Schema to events-types.schema.json.
import type {
  Cursor,
  JSONRPCRequest,
  MetaObject,
  PaginatedRequestParams,
  PaginatedResult,
  RequestParams,
  Result,
} from './vendor/mcp-spec/2026-07-28/schema';

/** The extension's identifier, a key in `capabilities.extensions`. */
export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';

/* Error codes. SEP-3415 names them for reuse across MCP; they are provisional until accepted. */
export const NOT_FOUND = -32023;
export const FORBIDDEN = -32024;
export const RESOURCE_EXHAUSTED = -32025;
export const UNSUPPORTED = -32026;
export const CALLBACK_ENDPOINT_ERROR = -32027;

/** A way to receive an event type's occurrences. */
export type DeliveryMode = 'poll' | 'push' | 'webhook';

/** An event type a server offers, as `events/list` lists it. */
export interface EventType {
  name: string;
  description?: string;
  /** The delivery modes the type supports, a non-empty subset. */
  delivery: DeliveryMode[];
  /** A JSON Schema for a subscription's `arguments`. */
  inputSchema: { type: 'object'; [key: string]: unknown };
  /** A JSON Schema for an occurrence's `data`. */
  payloadSchema: { type: 'object'; [key: string]: unknown };
  _meta?: MetaObject;
}

export interface EventsListRequest extends JSONRPCRequest {
  method: 'events/list';
  params: PaginatedRequestParams;
}

export interface EventsListResult extends PaginatedResult {
  events: EventType[];
}

/** Where and how a webhook subscription delivers. */
export interface WebhookDelivery {
  /** Every example in SEP-3415 carries it, though its text requires only `url` and `secret`. */
  mode?: 'webhook';
  /** The callback URL, which must be `https`. */
  url: string;
  /** A Standard Webhooks secret: `whsec_` and the base64 of 24 to 64 random bytes. */
  secret: string;
}

export interface EventsSubscribeRequestParams extends RequestParams {
  name: string;
  arguments?: { [key: string]: unknown };
  delivery: WebhookDelivery;
  /** Where delivery begins. `null`, or absent, means from now. */
  cursor?: Cursor | null;
  maxAgeMs?: number;
  /** The suggested lifetime in milliseconds. `null` asks for no expiry. */
  ttlMs?: number | null;
}

export interface EventsSubscribeRequest extends JSONRPCRequest {
  method: 'events/subscribe';
  params: EventsSubscribeRequestParams;
}

export interface WebhookDeliveryStatus {
  active: boolean;
  lastDeliveryAt?: string | null;
  lastError?: 'connection_refused' | 'timeout' | 'tls_error' | 'http_4xx' | 'http_5xx' | 'challenge_failed' | null;
  failedSince?: string;
  throttled?: boolean;
  retryAfterMs?: number;
}

export interface EventsSubscribeResult extends Result {
  /** Derived from the subscription key, and carried in `X-MCP-Subscription-Id` on every delivery. */
  id: string;
  /** When the grant ends, or `null` for no expiry. */
  refreshBefore: string | null;
  cursor?: Cursor | null;
  truncated?: boolean;
  deliveryStatus?: WebhookDeliveryStatus;
}

export interface EventsUnsubscribeRequestParams extends RequestParams {
  name: string;
  arguments?: { [key: string]: unknown };
  delivery: { url: string };
}

export interface EventsUnsubscribeRequest extends JSONRPCRequest {
  method: 'events/unsubscribe';
  params: EventsUnsubscribeRequestParams;
}

export interface EventsPollRequestParams extends RequestParams {
  name: string;
  arguments?: { [key: string]: unknown };
  cursor?: Cursor | null;
  maxAgeMs?: number;
  maxEvents?: number;
}

export interface EventsPollRequest extends JSONRPCRequest {
  method: 'events/poll';
  params: EventsPollRequestParams;
}

export interface EventsStreamRequest extends JSONRPCRequest {
  method: 'events/stream';
  params: EventsPollRequestParams;
}

/** One occurrence of an event type, the body of a webhook delivery. */
export interface EventOccurrence {
  /** The upstream event's identity, the same on every subscription it matches. */
  eventId: string;
  name: string;
  /** When the event occurred, in ISO 8601. */
  timestamp: string;
  data: { [key: string]: unknown };
  /** The subscription's position after this event, or `null` for a type with no replay. */
  cursor?: Cursor | null;
  _meta?: MetaObject;
}

/** The control envelope that asks a callback endpoint to prove it wants deliveries. */
export interface VerificationEnvelope {
  type: 'verification';
  challenge: string;
}

/** What `mcp.resource.updated` carries in `data`, and takes as `arguments`: the resource's URI. */
export interface ResourceUpdatedData {
  uri: string;
}
