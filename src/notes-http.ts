// Plain HTTP on A's notes and lists, as RFC 9110 defines it: a GET or HEAD carries the version
// as a strong ETag and answers a matching If-None-Match with 304, and every method honours
// If-Match and If-None-Match. A folder's GET lists its members' URIs and has no ETag.
import { readCapped } from './read-capped';
import { parseTarget, TYPES, type Target } from './server-role/targets';
import { resourceErrors } from './server-role/validation';
import { passes, type Preconditions, type VersionCondition, type VersionStore } from './server-role/version-store';

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
  const errors = resourceErrors(TYPES[target.type].definition, value);
  if (errors.length > 0) return Response.json({ error: 'The body does not match its type', errors }, { status: 400 });

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
