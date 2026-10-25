// Plain HTTP on A's notes and lists, as RFC 9110 defines it: a GET or HEAD carries the version
// as a strong ETag and answers a matching If-None-Match with 304, and every method honours
// If-Match and If-None-Match. A folder's GET lists its members' URIs and has no ETag.
import { Validator } from '@cfworker/json-schema';
import schema from './resource-types.schema.json';
import { passes, type Preconditions, type VersionCondition, type VersionStore } from './version-store';

/** A write's body cap, well under SQLite's 2 MB row limit. */
export const MAX_BODY_BYTES = 1024 * 1024;

const TYPES = {
  notes: { singular: 'note', validator: validatorFor('Note') },
  lists: { singular: 'list', validator: validatorFor('List') },
} as const;

type TypeName = keyof typeof TYPES;

// A path segment uses only URL-unreserved characters, so no URI A serves needs escaping.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

interface Target {
  type: TypeName;
  /** The path relative to A's root, as `/notes/inbox/note-42`. */
  path: string;
  resource: boolean;
}

/**
 * Answers one request for a path relative to A's root. `root` is A's own URI, such as
 * `https://….workers.dev/server/A`, which a folder's members are written under.
 */
export async function serveNotes(
  request: Request,
  path: string,
  root: string,
  store: VersionStore,
): Promise<Response> {
  const target = parseTarget(path);
  if (!target) return text(404, 'Not Found');
  if (!target.resource) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    const members = store.members(target.path).map((member) => `${root}${member}`);
    return Response.json({ members });
  }
  switch (request.method) {
    case 'GET':
    case 'HEAD':
      return get(request, target, store);
    case 'PUT':
      return put(request, target, store);
    case 'DELETE':
      return remove(request, target, store);
    default:
      return text(405, 'Method Not Allowed', { Allow: 'GET, HEAD, PUT, DELETE' });
  }
}

function get(request: Request, target: Target, store: VersionStore): Response {
  const current = store.current(target.path);
  if (!current || current.deleted) return text(404, 'Not Found');
  const etag = quote(current.version);
  const { ifMatch, ifNoneMatch } = preconditions(request);
  if (!passes(current.version, { ifMatch })) return text(412, 'Precondition Failed');
  if (!passes(current.version, { ifNoneMatch })) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  // A HEAD's body is dropped by the runtime, as HTTP requires, so HEAD shares GET's answer.
  return new Response(current.contents, {
    headers: { 'Content-Type': 'application/json', ETag: etag },
  });
}

async function put(request: Request, target: Target, store: VersionStore): Promise<Response> {
  const bytes = await readCapped(request.body);
  if (!bytes) return text(413, 'Content Too Large');

  // A's contents are the bytes as sent, so the ETag a PUT answers names exactly what a GET
  // returns, as RFC 9110 requires of a validator in a PUT's response. So the decoder refuses
  // bytes that are not UTF-8 rather than replace them, and keeps a byte-order mark.
  let body: string;
  let value: unknown;
  try {
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(body);
  } catch {
    return Response.json({ error: 'The body is not JSON in UTF-8' }, { status: 400 });
  }
  const { valid, errors } = TYPES[target.type].validator.validate(value);
  if (!valid) return Response.json({ error: 'The body does not match its type', errors }, { status: 400 });

  const result = store.put(target.path, body, preconditions(request));
  if (result.outcome !== 'written') return text(412, 'Precondition Failed');
  return new Response(null, { status: result.created ? 201 : 204, headers: { ETag: quote(result.version) } });
}

function remove(request: Request, target: Target, store: VersionStore): Response {
  const result = store.delete(target.path, preconditions(request));
  if (result.outcome === 'precondition-failed') return text(412, 'Precondition Failed');
  if (result.outcome === 'not-found') return text(404, 'Not Found');
  return new Response(null, { status: 204 });
}

// Reads the body and stops at the cap, whatever its Content-Length says, and whether or not it
// declares one, as a streamed body does not.
async function readCapped(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (stream) {
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) return undefined;
      chunks.push(chunk);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseTarget(path: string): Target | undefined {
  const [empty, type, ...segments] = path.split('/');
  if (empty !== '' || !(type in TYPES) || segments.some((segment) => !SEGMENT.test(segment))) {
    return undefined;
  }
  const { singular } = TYPES[type as TypeName];
  const names = segments.map((segment) => segment.startsWith(`${singular}-`));
  // A resource has no members, so only the last segment may name one.
  if (names.slice(0, -1).some(Boolean)) return undefined;
  return { type: type as TypeName, path, resource: names.at(-1) ?? false };
}

function preconditions(request: Request): Preconditions {
  return {
    ifMatch: entityTags(request.headers.get('If-Match'), 'strong'),
    ifNoneMatch: entityTags(request.headers.get('If-None-Match'), 'weak'),
  };
}

// Parses an If-Match or If-None-Match header into versions. If-Match compares strongly, so a
// weak tag never matches; If-None-Match compares weakly, so `W/` is ignored.
function entityTags(header: string | null, comparison: 'strong' | 'weak'): VersionCondition | undefined {
  if (header === null) return undefined;
  if (header.trim() === '*') return '*';
  return header
    .split(',')
    .map((tag) => tag.trim())
    .map((tag) => (comparison === 'weak' ? tag.replace(/^W\//, '') : tag))
    .filter((tag) => /^"[^"]*"$/.test(tag))
    .map((tag) => tag.slice(1, -1));
}

function quote(version: string): string {
  return `"${version}"`;
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function validatorFor(name: 'Note' | 'List'): Validator {
  return new Validator({ ...schema, $ref: `#/$defs/${name}` } as object, '2020-12');
}
