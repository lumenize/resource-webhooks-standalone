// The JSON-RPC 2.0 core under A's MCP endpoint: telling a request from a notification and from
// an invalid message, building error responses, and the HTTP status each error maps to.
// Adapted from json-rpc-mixin 0.0.6 at its repository's commit ce22f98 (Copyright (c) 2025 Larry
// Maccherone, MIT, relicensed here under Apache-2.0 by its author): its processing core and its error-to-status mapping, without
// zod, `agents`, dispatch by reflection, batches or its WebSocket envelope. Listed in
// ATTRIBUTIONS.md.
import {
  HEADER_MISMATCH,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  JSONRPC_VERSION,
  METHOD_NOT_FOUND,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  PARSE_ERROR,
  UNSUPPORTED_PROTOCOL_VERSION,
  type JSONRPCErrorResponse,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type RequestId,
} from './vendor/mcp-spec/2026-07-28/schema';

/** An error to answer with, carrying its JSON-RPC code. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export type Classified =
  | { kind: 'request'; message: JSONRPCRequest }
  | { kind: 'notification'; message: JSONRPCNotification };

/**
 * Tells a request from a notification, and throws `INVALID_REQUEST` for anything else. MCP's
 * Streamable HTTP carries one message per POST, so an array, a batch in JSON-RPC, is invalid
 * here, as is a response, which a client never sends.
 */
export function classify(value: unknown): Classified {
  // An array, a batch, has no `jsonrpc` member, so it fails here too.
  const message = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (message.jsonrpc !== JSONRPC_VERSION) {
    throw new JsonRpcError(INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
  }
  if (typeof message.method !== 'string') {
    throw new JsonRpcError(INVALID_REQUEST, 'Invalid Request: method must be a string');
  }
  if ('params' in message && (typeof message.params !== 'object' || message.params === null || Array.isArray(message.params))) {
    throw new JsonRpcError(INVALID_REQUEST, 'Invalid Request: params must be an object');
  }
  if (!('id' in message)) return { kind: 'notification', message: message as unknown as JSONRPCNotification };
  if (typeof message.id !== 'string' && typeof message.id !== 'number') {
    throw new JsonRpcError(INVALID_REQUEST, 'Invalid Request: id must be a string or a number');
  }
  return { kind: 'request', message: message as unknown as JSONRPCRequest };
}

/** An error response. With no id, as when the message could not be read, the id is left out. */
export function errorResponse(id: RequestId | undefined, error: JsonRpcError): JSONRPCErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    ...(id === undefined ? {} : { id }),
    error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) },
  };
}

/** Any thrown value as a `JsonRpcError`, an unexpected one as `INTERNAL_ERROR`. */
export function asJsonRpcError(error: unknown): JsonRpcError {
  return error instanceof JsonRpcError ? error : new JsonRpcError(INTERNAL_ERROR, 'Internal error');
}

/** The HTTP status for an error code, as MCP's Streamable HTTP and JSON-RPC over HTTP give it. */
export function httpStatusFor(code: number): number {
  switch (code) {
    case PARSE_ERROR:
    case INVALID_REQUEST:
    case INVALID_PARAMS:
    case HEADER_MISMATCH:
    case MISSING_REQUIRED_CLIENT_CAPABILITY:
    case UNSUPPORTED_PROTOCOL_VERSION:
      return 400;
    case METHOD_NOT_FOUND:
      return 404;
    default:
      return 500;
  }
}
