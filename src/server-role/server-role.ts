// A's role as an MCP server of 2026-07-28: its core methods, its two tools, and its notes and
// lists as resources. It takes a message the transport has already read and checked, and `sql`
// from its host, so a Lumenize node can compose it as a Durable Object does here.
import { JsonRpcError } from '../json-rpc';
import type {
  CallToolResult,
  ClientCapabilities,
  DiscoverResult,
  Implementation,
  JSONRPCRequest,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Result,
  TextResourceContents,
  BlobResourceContents,
  Tool,
} from '../vendor/mcp-spec/2026-07-28/schema';
import { INVALID_PARAMS, LATEST_PROTOCOL_VERSION, METHOD_NOT_FOUND } from '../vendor/mcp-spec/2026-07-28/schema';
import type { DeleteNoteArguments, NoteVersion, WriteNoteArguments } from '../tool-types';
import { parseTarget, TYPES, type Target } from './targets';
import { REQUEST_DEFINITIONS, specErrors, toolErrors, toolSchemaFor } from './validation';
import { VersionStore } from './version-store';

export const SERVER_INFO: Implementation = { name: 'resource-webhooks-standalone', version: '0.0.0' };

/** A tool beyond A's own, with what calling it answers. It may throw a `JsonRpcError`. */
export interface ExtraTool {
  tool: Tool;
  call(args: Record<string, unknown>, clientCapabilities: ClientCapabilities): CallToolResult;
}

/** A resource beyond A's notes and lists. */
export interface ExtraResource {
  resource: Resource;
  contents: TextResourceContents | BlobResourceContents;
}

/** A resource template beyond A's two, with what reading a URI it matches answers. */
export interface ExtraTemplate {
  template: ResourceTemplate;
  read(uri: string): (TextResourceContents | BlobResourceContents) | undefined;
}

/** What a host adds to A's own tools, resources and templates, as the conformance suite's fixtures. */
export interface ServerExtras {
  tools?: readonly ExtraTool[];
  resources?: readonly ExtraResource[];
  templates?: readonly ExtraTemplate[];
}

export interface ServerRoleOptions {
  sql: SqlStorage;
  /** A's own URI, as `https://….workers.dev/server/A`, which every note's URI starts with. */
  root: string;
  cutoffWindowMs: number;
  extras?: ServerExtras;
}

type Contents = TextResourceContents | BlobResourceContents;

// Every read result answers ttlMs 0, so no cache serves a version older than one a delivery names.
const UNCACHED = { ttlMs: 0, cacheScope: 'public' } as const;

const WRITE_NOTE: Tool = {
  name: 'write_note',
  title: 'Write a note',
  description: 'Creates or replaces a note. With version, it writes only if the note is still at that version.',
  inputSchema: toolSchemaFor('WriteNoteArguments'),
  outputSchema: toolSchemaFor('NoteVersion'),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

const DELETE_NOTE: Tool = {
  name: 'delete_note',
  title: 'Delete a note',
  description: 'Deletes a note. With version, it deletes only if the note is still at that version.',
  inputSchema: toolSchemaFor('DeleteNoteArguments'),
  outputSchema: toolSchemaFor('NoteVersion'),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

export class ServerRole {
  readonly store: VersionStore;
  readonly #root: string;
  readonly #extras: ServerExtras;
  // A Map, so a method named after something on Object.prototype, as `constructor`, finds nothing.
  readonly #methods: ReadonlyMap<string, (params: Record<string, unknown>) => Result>;

  constructor({ sql, root, cutoffWindowMs, extras = {} }: ServerRoleOptions) {
    this.store = new VersionStore(sql, { cutoffWindowMs });
    this.#root = root;
    this.#extras = extras;
    this.#methods = new Map<string, (params: Record<string, unknown>) => Result>([
      ['server/discover', () => this.#discover()],
      ['tools/list', (params) => this.#listTools(params)],
      ['tools/call', (params) => this.#callTool(params)],
      ['resources/list', (params) => this.#listResources(params)],
      ['resources/templates/list', (params) => this.#listTemplates(params)],
      ['resources/read', (params) => this.#read(params)],
    ]);
  }

  /**
   * Answers one request whose envelope and headers the transport has checked. Throws a
   * `JsonRpcError` for an unknown method, for params the spec's schema refuses, and for a
   * request A cannot answer.
   */
  handle(request: JSONRPCRequest): Result {
    const method = this.#methods.get(request.method);
    if (!method) throw new JsonRpcError(METHOD_NOT_FOUND, `Method not found: ${request.method}`);
    const errors = specErrors(REQUEST_DEFINITIONS.get(request.method)!, request);
    if (errors.length > 0) throw new JsonRpcError(INVALID_PARAMS, 'Invalid params', errors.slice(0, 10));
    const result = method(request.params ?? {});
    return { ...result, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO, ...result._meta } };
  }

  #discover(): DiscoverResult {
    return {
      resultType: 'complete',
      supportedVersions: [LATEST_PROTOCOL_VERSION],
      capabilities: { tools: {}, resources: {} },
      ...UNCACHED,
    };
  }

  #listTools(params: Record<string, unknown>): ListToolsResult {
    requireNoCursor(params);
    return { resultType: 'complete', tools: [WRITE_NOTE, DELETE_NOTE, ...(this.#extras.tools ?? []).map(({ tool }) => tool)], ...UNCACHED };
  }

  #callTool(params: Record<string, unknown>): CallToolResult {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    switch (params.name) {
      case WRITE_NOTE.name:
        return this.#writeNote(argumentsFor('WriteNoteArguments', args) as unknown as WriteNoteArguments);
      case DELETE_NOTE.name:
        return this.#deleteNote(argumentsFor('DeleteNoteArguments', args) as unknown as DeleteNoteArguments);
    }
    const extra = this.#extras.tools?.find(({ tool }) => tool.name === params.name);
    if (!extra) throw new JsonRpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
    const meta = params._meta as { 'io.modelcontextprotocol/clientCapabilities': ClientCapabilities };
    return extra.call(args, meta['io.modelcontextprotocol/clientCapabilities']);
  }

  #writeNote({ uri, note, version }: WriteNoteArguments): CallToolResult {
    const path = this.#notePath(uri);
    const result = this.store.put(path, JSON.stringify(note), version === undefined ? {} : { ifMatch: [version] });
    if (result.outcome !== 'written') return toolError(`${uri} is not at version ${version}`);
    return toolResult({ uri, version: result.version });
  }

  #deleteNote({ uri, version }: DeleteNoteArguments): CallToolResult {
    const path = this.#notePath(uri);
    const result = this.store.delete(path, version === undefined ? {} : { ifMatch: [version] });
    if (result.outcome === 'not-found') return toolError(`There is no note at ${uri}`);
    if (result.outcome === 'precondition-failed') return toolError(`${uri} is not at version ${version}`);
    return toolResult({ uri, version: result.version });
  }

  #listResources(params: Record<string, unknown>): ListResourcesResult {
    requireNoCursor(params);
    const own = [...this.store.members('/notes/inbox'), ...this.store.members('/lists')].map((path) => this.#resource(path));
    return { resultType: 'complete', resources: [...own, ...(this.#extras.resources ?? []).map(({ resource }) => resource)], ...UNCACHED };
  }

  #listTemplates(params: Record<string, unknown>): ListResourceTemplatesResult {
    requireNoCursor(params);
    const own: ResourceTemplate[] = Object.entries(TYPES).map(([type, { singular }]) => ({
      uriTemplate: `${this.#root}/${type}/{+path}`,
      name: type,
      description: `A ${singular}, or a folder of ${type}`,
      mimeType: 'application/json',
    }));
    return {
      resultType: 'complete',
      resourceTemplates: [...own, ...(this.#extras.templates ?? []).map(({ template }) => template)],
      ...UNCACHED,
    };
  }

  #read(params: Record<string, unknown>): ReadResourceResult {
    const uri = params.uri as string;
    const contents = this.#contents(uri);
    if (!contents) throw new JsonRpcError(INVALID_PARAMS, 'Resource not found', { uri });
    return { resultType: 'complete', contents, ...UNCACHED };
  }

  // A resource answers one entry, a folder one per live member, and anything else nothing.
  #contents(uri: string): Contents[] | undefined {
    const target = this.#target(uri);
    if (target?.resource) {
      const current = this.store.current(target.path);
      return current && !current.deleted ? [this.#entry(target.path, current.contents)] : undefined;
    }
    if (target) {
      return this.store.members(target.path).map((path) => {
        const current = this.store.current(path) as { contents: string };
        return this.#entry(path, current.contents);
      });
    }
    const resource = this.#extras.resources?.find((extra) => extra.resource.uri === uri);
    if (resource) return [resource.contents];
    for (const { read } of this.#extras.templates ?? []) {
      const entry = read(uri);
      if (entry) return [entry];
    }
    return undefined;
  }

  #entry(path: string, text: string): TextResourceContents {
    return { uri: `${this.#root}${path}`, mimeType: 'application/json', text };
  }

  #resource(path: string): Resource {
    const current = this.store.current(path) as { contents: string };
    const { title } = JSON.parse(current.contents) as { title: string };
    return { uri: `${this.#root}${path}`, name: path.slice(path.lastIndexOf('/') + 1), title, mimeType: 'application/json' };
  }

  #target(uri: string): Target | undefined {
    return uri.startsWith(`${this.#root}/`) ? parseTarget(uri.slice(this.#root.length)) : undefined;
  }

  #notePath(uri: string): string {
    const target = this.#target(uri);
    if (!target?.resource || target.type !== 'notes') {
      throw new JsonRpcError(INVALID_PARAMS, `Not a note of this server's: ${uri}`);
    }
    return target.path;
  }
}

function argumentsFor(definition: 'WriteNoteArguments' | 'DeleteNoteArguments', args: Record<string, unknown>) {
  const errors = toolErrors(definition, args);
  if (errors.length > 0) throw new JsonRpcError(INVALID_PARAMS, 'Invalid tool arguments', errors.slice(0, 10));
  return args;
}

// A never pages, so no cursor it could be given is one it issued.
function requireNoCursor(params: Record<string, unknown>): void {
  if (params.cursor !== undefined) throw new JsonRpcError(INVALID_PARAMS, 'Invalid cursor');
}

function toolResult(structured: NoteVersion): CallToolResult {
  return { resultType: 'complete', content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

function toolError(text: string): CallToolResult {
  return { resultType: 'complete', content: [{ type: 'text', text }], isError: true };
}
