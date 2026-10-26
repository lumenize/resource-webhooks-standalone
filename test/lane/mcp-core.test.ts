import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { headerValue, McpError } from '../../src/client/mcp-client';
import { SERVER_INFO } from '../../src/server-role/server-role';
import { specErrors } from '../../src/server-role/validation';
import { newLane, type Lane } from './lane';

const META = { 'io.modelcontextprotocol/serverInfo': SERVER_INFO };
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

// A POST built by hand, with the lane's token, so a test can send what the client never would.
async function post(lane: Lane, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return lane.fetch('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await lane.token()}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function headersFor(method: string, name?: string): Record<string, string> {
  return { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(name === undefined ? {} : { 'Mcp-Name': name }) };
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: number; message: string; data?: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpError) return { status: error.status, code: error.code, message: error.message, data: error.data };
    throw error;
  }
  throw new Error('The request was not refused');
}

// A's rows, read below the public API: MCP answers no row a refused write left alone.
function rows(lane: Lane) {
  return runInDurableObject(lane.stub, (_instance, state) =>
    state.storage.sql.exec('SELECT stamp, path, contents, deleted FROM Versions ORDER BY stamp').toArray(),
  );
}

describe('Scenario 1a: MCP core as it is', () => {
  it('writes a note with write_note and reads it with resources/read, which names no version', async () => {
    const lane = newLane();
    const uri = `${lane.root}/notes/inbox/note-42`;

    const written = await lane.client.request('tools/call', { name: 'write_note', arguments: { uri, note: { title: 'Buy milk' } } });
    const version = (written.structuredContent as { version: string }).version;
    expect(version).toMatch(/^e0\.\d+$/);
    expect(written).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: JSON.stringify({ uri, version }) }],
      structuredContent: { uri, version },
      _meta: META,
    });

    const read = await lane.client.request('resources/read', { uri });
    expect(read).toEqual({
      resultType: 'complete',
      contents: [{ uri, mimeType: 'application/json', text: '{"title":"Buy milk"}' }],
      ttlMs: 0,
      cacheScope: 'public',
      _meta: META,
    });
  });
});

describe('the core methods', () => {
  it('discovers one protocol version, tools, resources, Events and resource webhooks', async () => {
    const lane = newLane();
    expect(await lane.client.request('server/discover')).toEqual({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: {
        tools: {},
        resources: {},
        extensions: { 'io.modelcontextprotocol/events': {}, 'io.modelcontextprotocol/resource-webhooks': { forms: ['notify', 'full'] } },
      },
      ttlMs: 0,
      cacheScope: 'public',
      _meta: META,
    });
  });

  it('lists write_note and delete_note, each with its generated schema', async () => {
    const lane = newLane();
    const { tools } = await lane.client.request<{ resultType: string; tools: { name: string; inputSchema: { required: string[] } }[] }>('tools/list');
    expect(tools.map(({ name }) => name)).toEqual(['write_note', 'delete_note']);
    expect(tools[0].inputSchema.required).toEqual(['note', 'uri']);
  });

  it("lists the inbox's notes and every list, and one template per type", async () => {
    const lane = newLane();
    await lane.client.request('tools/call', { name: 'write_note', arguments: { uri: `${lane.root}/notes/inbox/note-42`, note: { title: 'Buy milk' } } });
    await lane.client.request('tools/call', { name: 'write_note', arguments: { uri: `${lane.root}/notes/archive/note-1`, note: { title: 'Old' } } });
    await lane.fetch('/lists/list-7', { method: 'PUT', body: '{"title":"Groceries","items":["oat milk"]}' });

    const { resources } = await lane.client.request<{ resultType: string; resources: unknown[] }>('resources/list');
    expect(resources).toEqual([
      { uri: `${lane.root}/notes/inbox/note-42`, name: 'note-42', title: 'Buy milk', mimeType: 'application/json' },
      { uri: `${lane.root}/lists/list-7`, name: 'list-7', title: 'Groceries', mimeType: 'application/json' },
    ]);
    const { resourceTemplates } = await lane.client.request<{ resultType: string; resourceTemplates: unknown[] }>('resources/templates/list');
    expect(resourceTemplates).toEqual([
      { uriTemplate: `${lane.root}/notes/{+path}`, name: 'notes', description: 'A note, { title, done?, due? }, or a folder of notes', mimeType: 'application/json' },
      { uriTemplate: `${lane.root}/lists/{+path}`, name: 'lists', description: 'A list, { title, items }, or a folder of lists', mimeType: 'application/json' },
    ]);
  });

  it("reads a folder as one entry per note under it, and refuses a URI it does not serve with the URI in data", async () => {
    const lane = newLane();
    await lane.client.request('tools/call', { name: 'write_note', arguments: { uri: `${lane.root}/notes/inbox/note-42`, note: { title: 'Buy milk' } } });
    const folder = await lane.client.request<{ resultType: string; contents: { uri: string }[] }>('resources/read', { uri: `${lane.root}/notes/inbox` });
    expect(folder.contents.map(({ uri }) => uri)).toEqual([`${lane.root}/notes/inbox/note-42`]);

    const missing = `${lane.root}/notes/inbox/note-43`;
    expect(await refusal(lane.client.request('resources/read', { uri: missing }))).toEqual({
      status: 400,
      code: -32602,
      message: 'Resource not found',
      data: { uri: missing },
    });
  });

  it('refuses a resources/read without params.uri with -32602, from the method\'s own definition', async () => {
    const lane = newLane();
    const refused = await refusal(lane.client.request('resources/read', {}));
    expect(refused).toMatchObject({ status: 400, code: -32602, message: 'Invalid params' });
    expect(JSON.stringify(refused.data)).toContain('uri');
  });

  it('answers an unknown method with 404 and -32601, a name on Object.prototype included', async () => {
    const lane = newLane();
    for (const method of ['prompts/list', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const refused = await refusal(lane.client.request(method));
      expect({ method, status: refused.status, code: refused.code }).toEqual({ method, status: 404, code: -32601 });
    }
  });

  it("answers every core method with a result the spec's schema accepts", async () => {
    const lane = newLane();
    const uri = `${lane.root}/notes/inbox/note-42`;
    const results: [string, string, Record<string, unknown>?][] = [
      ['CallToolResult', 'tools/call', { name: 'write_note', arguments: { uri, note: { title: 'Buy milk' } } }],
      ['DiscoverResult', 'server/discover'],
      ['ListToolsResult', 'tools/list'],
      ['ListResourcesResult', 'resources/list'],
      ['ListResourceTemplatesResult', 'resources/templates/list'],
      ['ReadResourceResult', 'resources/read', { uri }],
    ];
    for (const [definition, method, params] of results) {
      const result = await lane.client.request(method, params);
      expect({ method, errors: specErrors(definition, result) }).toEqual({ method, errors: [] });
    }
  });

  it('refuses an unknown tool with -32602', async () => {
    const lane = newLane();
    expect(await refusal(lane.client.request('tools/call', { name: 'paint_note', arguments: {} }))).toMatchObject({
      status: 400,
      code: -32602,
      message: 'Unknown tool: paint_note',
    });
  });

  it('refuses a body over 1 MiB with 413', async () => {
    const lane = newLane();
    const response = await post(lane, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE, pad: 'x'.repeat(1024 * 1024) } }, headersFor('tools/list'));
    expect(response.status).toBe(413);
  });

  it('refuses a cursor it never issued with -32602', async () => {
    const lane = newLane();
    expect(await refusal(lane.client.request('tools/list', { cursor: 'c1' }))).toMatchObject({ status: 400, code: -32602, message: 'Invalid cursor' });
  });
});

describe('write_note', () => {
  it('refuses a stale version with isError, and leaves the rows as they were', async () => {
    const lane = newLane();
    const uri = `${lane.root}/notes/inbox/note-42`;
    const first = await lane.client.request('tools/call', { name: 'write_note', arguments: { uri, note: { title: 'Buy milk' } } });
    const v1 = (first.structuredContent as { version: string }).version;
    await lane.client.request('tools/call', { name: 'write_note', arguments: { uri, note: { title: 'Buy oat milk' }, version: v1 } });
    const before = await rows(lane);

    const stale = await lane.client.request('tools/call', { name: 'write_note', arguments: { uri, note: { title: 'Buy soy milk' }, version: v1 } });

    expect(stale).toEqual({ resultType: 'complete', content: [{ type: 'text', text: `${uri} is not at version ${v1}` }], isError: true, _meta: META });
    expect(await rows(lane)).toEqual(before);
  });

  it('refuses an unknown member, a null member, and a URI that is not a note of A\'s, leaving no row', async () => {
    const lane = newLane();
    const uri = `${lane.root}/notes/inbox/note-42`;
    const attempts = [
      { uri, note: { title: 'Buy milk', colour: 'blue' } },
      { uri, note: { title: 'Buy milk', done: null } },
      { uri, note: { title: 'Buy milk' }, extra: true },
      { uri: `${lane.root}/lists/list-7`, note: { title: 'Buy milk' } },
      { uri: 'https://elsewhere.example/notes/inbox/note-42', note: { title: 'Buy milk' } },
    ];
    for (const args of attempts) {
      const refused = await refusal(lane.client.request('tools/call', { name: 'write_note', arguments: args }));
      expect({ args, code: refused.code, status: refused.status }).toEqual({ args, code: -32602, status: 400 });
    }
    expect(await rows(lane)).toEqual([]);
  });

  it('deletes with delete_note, which answers the deletion\'s version, and refuses a missing note with isError', async () => {
    const lane = newLane();
    const uri = `${lane.root}/notes/inbox/note-42`;
    await lane.client.request('tools/call', { name: 'write_note', arguments: { uri, note: { title: 'Buy milk' } } });
    const deleted = await lane.client.request('tools/call', { name: 'delete_note', arguments: { uri } });
    expect((deleted.structuredContent as { version: string }).version).toMatch(/^e0\.\d+$/);
    expect(await lane.client.request('tools/call', { name: 'delete_note', arguments: { uri } })).toMatchObject({ isError: true });
    expect((await lane.fetch('/notes/inbox/note-42')).status).toBe(404);
  });
});

describe('the transport', () => {
  // null sends params with no _meta at all.
  const discover = (envelope: object | null = ENVELOPE) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: envelope === null ? {} : { _meta: envelope },
  });

  it('refuses a request without the _meta envelope with 400 and -32602', async () => {
    const lane = newLane();
    const response = await post(lane, discover(null), headersFor('server/discover'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ id: 1, error: { code: -32602 } });
  });

  it('refuses a protocol version it does not speak with 400 and -32022, naming the one it does', async () => {
    const lane = newLane();
    const response = await post(lane, discover({ ...ENVELOPE, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' }), {
      ...headersFor('server/discover'),
      'MCP-Protocol-Version': '2025-11-25',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32022, data: { supported: ['2026-07-28'], requested: '2025-11-25' } } });
  });

  it('refuses a header that disagrees with the body, or is missing, with 400 and HeaderMismatch', async () => {
    const lane = newLane();
    const uri = `${lane.root}/notes/inbox/note-42`;
    const read = { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri, _meta: ENVELOPE } };
    const cases: [string, unknown, Record<string, string>][] = [
      ['Mcp-Name disagrees', read, headersFor('resources/read', `${lane.root}/notes/inbox/note-43`)],
      ['Mcp-Name missing', read, headersFor('resources/read')],
      ['MCP-Protocol-Version disagrees with _meta', read, { ...headersFor('resources/read', uri), 'MCP-Protocol-Version': '2025-11-25' }],
      ['MCP-Protocol-Version missing', read, { 'Mcp-Method': 'resources/read', 'Mcp-Name': uri }],
      ['Mcp-Method disagrees', read, headersFor('tools/list', uri)],
      ['Mcp-Name encoded, but of another value', read, headersFor('resources/read', `=?base64?${btoa('note-43')}?=`)],
    ];
    for (const [label, body, headers] of cases) {
      const response = await post(lane, body, headers);
      expect({ label, status: response.status, code: ((await response.json()) as { error?: { code: number } }).error?.code }).toEqual({
        label,
        status: 400,
        code: -32020,
      });
    }
  });

  it('answers a header that disagrees with an unsupported body version as a mismatch, not as the version', async () => {
    const lane = newLane();
    const response = await post(lane, discover({ ...ENVELOPE, 'io.modelcontextprotocol/protocolVersion': '1999-01-01' }), headersFor('server/discover'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32020 } });
  });

  it('decodes a Base64 Mcp-Name before comparing it', async () => {
    const lane = newLane();
    await lane.client.request('tools/call', { name: 'write_note', arguments: { uri: `${lane.root}/notes/inbox/note-42`, note: { title: 'Buy milk' } } });
    const uri = `${lane.root}/notes/inbox/note-42`;
    const encoded = `=?base64?${btoa(uri)}?=`;
    const response = await post(lane, { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri, _meta: ENVELOPE } }, headersFor('resources/read', encoded));
    expect(response.status).toBe(200);
    expect(headerValue('Buy milk ')).toBe(`=?base64?${btoa('Buy milk ')}?=`);
    expect(headerValue(uri)).toBe(uri);
  });

  it('accepts a notification with 202 and no body', async () => {
    const lane = newLane();
    const response = await post(lane, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });
});

// The JSON-RPC 2.0 specification's own examples, as json-rpc-mixin tested them.
describe('JSON-RPC 2.0 examples', () => {
  it('answers invalid JSON with 400 and -32700, and no id', async () => {
    const response = await post(newLane(), '{"jsonrpc": "2.0", "method": "foobar, "params": "bar", "baz]');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
  });

  it('answers an invalid Request object with 400 and -32600', async () => {
    const response = await post(newLane(), { jsonrpc: '2.0', method: 1, params: 'bar' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } });
  });

  it('answers a batch, empty or not, with 400 and -32600, since a POST carries one message', async () => {
    const lane = newLane();
    for (const batch of [[], [{ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: ENVELOPE } }]]) {
      const response = await post(lane, batch, headersFor('server/discover'));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: -32600 } });
    }
  });

  it('answers a message that is not a JSON-RPC 2.0 request with 400 and -32600', async () => {
    const lane = newLane();
    const invalid = [
      { jsonrpc: '1.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } },
      { jsonrpc: '2.0', id: null, method: 'tools/list', params: { _meta: ENVELOPE } },
      { jsonrpc: '2.0', id: 1.5, method: 'tools/list', params: { _meta: ENVELOPE } },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: 'bar' },
      { jsonrpc: '2.0', id: 1, result: { resultType: 'complete' } },
    ];
    for (const message of invalid) {
      const response = await post(lane, message, headersFor('tools/list'));
      expect({ message, status: response.status, code: ((await response.json()) as { error: { code: number } }).error.code }).toEqual({
        message,
        status: 400,
        code: -32600,
      });
    }
  });

  it('answers a call of a method that does not exist with 404 and -32601', async () => {
    const response = await post(newLane(), { jsonrpc: '2.0', id: '1', method: 'foobar', params: { _meta: ENVELOPE } }, headersFor('foobar'));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: '1', error: { code: -32601 } });
  });
});
