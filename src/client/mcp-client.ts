// An MCP client of 2026-07-28 over Streamable HTTP, using only `fetch`, so a browser page, a
// script and the tests share it. Each request carries the `_meta` envelope and the headers that
// mirror its body.
import type { Implementation, JSONRPCErrorResponse, Result } from '../vendor/mcp-spec/2026-07-28/schema';

export const PROTOCOL_VERSION = '2026-07-28';

/** The error a request was answered with, and the HTTP status it came with. */
export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly status: number;

  constructor(status: number, error: JSONRPCErrorResponse['error']) {
    super(error.message);
    this.name = 'McpError';
    this.code = error.code;
    this.data = error.data;
    this.status = status;
  }
}

export interface McpClientOptions {
  /** The server's MCP endpoint, as `https://….workers.dev/server/A/mcp`. */
  endpoint: string;
  clientInfo?: Implementation;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface McpClient {
  /** Sends one request and answers its result, or throws an `McpError`. */
  request<R extends Result = Result>(method: string, params?: Record<string, unknown>): Promise<R>;
}

const NAME_SOURCES: Readonly<Record<string, 'name' | 'uri'>> = {
  'tools/call': 'name',
  'resources/read': 'uri',
  'prompts/get': 'name',
};

export function createMcpClient({ endpoint, clientInfo, fetch: send = fetch }: McpClientOptions): McpClient {
  let nextId = 1;
  return {
    async request<R extends Result>(method: string, params: Record<string, unknown> = {}): Promise<R> {
      const id = nextId++;
      const meta = {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
        ...(clientInfo ? { 'io.modelcontextprotocol/clientInfo': clientInfo } : {}),
      };
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': method,
      };
      const source = NAME_SOURCES[method];
      if (source && typeof params[source] === 'string') headers['Mcp-Name'] = headerValue(params[source] as string);
      const response = await send(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }),
      });
      const message = (await response.json()) as { result?: R; error?: JSONRPCErrorResponse['error'] };
      if (message.error) throw new McpError(response.status, message.error);
      return message.result as R;
    },
  };
}

// A value a plain header cannot carry, or one that looks like the sentinel, goes as Base64.
export function headerValue(value: string): string {
  const plain = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value);
  if (plain && !/^=\?base64\?.*\?=$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  return `=?base64?${btoa(String.fromCharCode(...bytes))}?=`;
}
