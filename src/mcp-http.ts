// A's MCP endpoint on MCP 2026-07-28's Streamable HTTP, stateless and JSON only: one message
// per POST, no session and no SSE. It checks what the transport owns, the `_meta` envelope, the
// protocol version and the headers that mirror the body, and hands the request to A's role.
import { asJsonRpcError, classify, errorResponse, httpStatusFor, JsonRpcError } from './json-rpc';
import { readCapped } from './read-capped';
import type { ServerRole } from './server-role/server-role';
import {
  HEADER_MISMATCH,
  INVALID_PARAMS,
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  PARSE_ERROR,
  UNSUPPORTED_PROTOCOL_VERSION,
  type JSONRPCRequest,
  type RequestId,
} from './vendor/mcp-spec/2026-07-28/schema';

/**
 * The methods whose requests mirror a body value in `Mcp-Name`, and the params it may come from,
 * the first one present.
 */
const MCP_NAME_SOURCES: ReadonlyMap<string, readonly string[]> = new Map([
  ['tools/call', ['name']],
  ['resources/read', ['uri']],
  ['prompts/get', ['name']],
  // SEP-3415 names the event type in Mcp-Name, as tools/call names the tool.
  ['events/subscribe', ['name']],
  ['events/unsubscribe', ['name']],
  ['events/poll', ['name']],
  ['events/stream', ['name']],
  // A target's uri or uriTemplate, as resources/read's uri, and none for a listed target (R40).
  ['resources/webhooks/subscribe', ['uri', 'uriTemplate']],
  ['resources/webhooks/unsubscribe', ['uri', 'uriTemplate']],
]);

const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/;

/** What A reports of each exchange on its endpoint, for the page to show. */
export type ExchangeReport = { kind: 'mcp'; method: string; params?: unknown; result?: unknown; error?: unknown };

/** Answers one POST to A's MCP endpoint, as the principal the edge verified, if any. */
export async function serveMcp(
  request: Request,
  role: ServerRole,
  principal: string | undefined,
  report?: (report: ExchangeReport) => void,
): Promise<Response> {
  const bytes = await readCapped(request.body);
  if (!bytes) return new Response('Content Too Large', { status: 413 });

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return answerError(undefined, new JsonRpcError(PARSE_ERROR, 'Parse error'));
  }

  let id: RequestId | undefined;
  try {
    const classified = classify(body);
    // This revision defines no notification a client sends over Streamable HTTP, and the
    // transport accepts any it is sent.
    if (classified.kind === 'notification') return new Response(null, { status: 202 });
    id = classified.message.id;
    requireEnvelope(classified.message);
    requireMatchingHeaders(request.headers, classified.message);
    requireSupportedVersion(classified.message);
    const result = await role.handle(classified.message, principal);
    report?.({ kind: 'mcp', method: classified.message.method, params: classified.message.params, result });
    return Response.json({ jsonrpc: JSONRPC_VERSION, id, result });
  } catch (error) {
    if (!(error instanceof JsonRpcError)) console.error('MCP request failed', { error });
    const answered = asJsonRpcError(error);
    const method = (body as { method?: unknown } | null)?.method;
    if (typeof method === 'string') report?.({ kind: 'mcp', method, error: { code: answered.code, message: answered.message } });
    return answerError(id, answered);
  }
}

// Every request carries its protocol version in `_meta`.
function requireEnvelope(message: JSONRPCRequest): void {
  const version = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  if (typeof version !== 'string') {
    throw new JsonRpcError(INVALID_PARAMS, 'Missing _meta envelope: params._meta["io.modelcontextprotocol/protocolVersion"] is required');
  }
}

// A speaks one version. A header that disagrees with the body is a mismatch first, since the
// two parties may each have read a different one.
function requireSupportedVersion(message: JSONRPCRequest): void {
  const version = message.params!._meta['io.modelcontextprotocol/protocolVersion'];
  if (version !== LATEST_PROTOCOL_VERSION) {
    throw new JsonRpcError(UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version: ${version}`, {
      supported: [LATEST_PROTOCOL_VERSION],
      requested: version,
    });
  }
}

// The headers mirror the body so intermediaries can route without parsing it, and a mismatch
// means two parties disagree about the request, so any mismatch is refused.
function requireMatchingHeaders(headers: Headers, message: JSONRPCRequest): void {
  const version = message.params!._meta['io.modelcontextprotocol/protocolVersion'];
  requireHeader(headers, 'MCP-Protocol-Version', version);
  requireHeader(headers, 'Mcp-Method', message.method);
  const sources = MCP_NAME_SOURCES.get(message.method);
  const value = sources?.map((name) => message.params?.[name]).find((each) => each !== undefined);
  // With no value in the body there is nothing to mirror, and a header then mismatches.
  if (sources && (value !== undefined || headers.has('Mcp-Name'))) {
    requireHeader(headers, 'Mcp-Name', value, { base64: true });
  }
}

function requireHeader(headers: Headers, name: string, bodyValue: unknown, { base64 = false } = {}): void {
  // RFC 9110 excludes the whitespace around a field value from the value.
  const raw = headers.get(name)?.replace(/^[ \t]+|[ \t]+$/g, '') ?? null;
  if (raw === null) throw new JsonRpcError(HEADER_MISMATCH, `Header mismatch: ${name} is missing`);
  const decoded = base64 ? decodeSentinel(raw, name) : raw;
  if (decoded !== bodyValue) {
    throw new JsonRpcError(HEADER_MISMATCH, `Header mismatch: ${name} header value '${raw}' does not match body value '${String(bodyValue)}'`);
  }
}

// `=?base64?…?=` carries a value a plain header cannot, as UTF-8 in Base64.
function decodeSentinel(raw: string, name: string): string {
  const match = BASE64_SENTINEL.exec(raw);
  if (!match) return raw;
  try {
    const binary = atob(match[1]);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    throw new JsonRpcError(HEADER_MISMATCH, `Header mismatch: ${name} is not valid Base64 of UTF-8`);
  }
}

function answerError(id: RequestId | undefined, error: JsonRpcError): Response {
  return Response.json(errorResponse(id, error), { status: httpStatusFor(error.code) });
}
