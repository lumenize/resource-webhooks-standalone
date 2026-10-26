// Which of A's paths name a resource and which a folder. A path is relative to A's root, as
// `/notes/inbox/note-42` under `https://….workers.dev/server/A`.

export const TYPES = {
  notes: { singular: 'note', definition: 'Note', shape: '{ title, done?, due? }' },
  lists: { singular: 'list', definition: 'List', shape: '{ title, items }' },
} as const;

export type TypeName = keyof typeof TYPES;

// A path segment uses only URL-unreserved characters and starts with a letter or digit, so no
// URI A serves needs escaping, and none holds a `.` or `..` segment that a URL would normalize.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

export interface Target {
  type: TypeName;
  path: string;
  /** A segment that starts with the type's singular and a hyphen, such as `note-42`, names a resource. */
  resource: boolean;
}

/** The target a path names, or undefined when A serves nothing there. */
export function parseTarget(path: string): Target | undefined {
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

/** A's own scheme for its lists, as `lists:///inbox/groceries`, readable only through `resources/read`. */
export const LISTS_SCHEME = 'lists:///';

/**
 * The path a `lists:` URI names, keeping A's rule that a list's last segment starts `list-`, so
 * `lists:///inbox/groceries` names `/lists/inbox/list-groceries`. The scheme names lists only, so
 * every URI under it names one, and `lists:///inbox` the list `inbox`. Undefined for any other URI,
 * or one with an empty or unusable segment.
 */
export function listPath(uri: string): string | undefined {
  if (!uri.startsWith(LISTS_SCHEME)) return undefined;
  const segments = uri.slice(LISTS_SCHEME.length).split('/');
  const name = segments.pop()!;
  // The name is a segment in its own right in the URI, so `.` and `..` would be normalized away.
  if (!SEGMENT.test(name)) return undefined;
  const path = `/lists/${[...segments, `list-${name}`].join('/')}`;
  return parseTarget(path)?.resource ? path : undefined;
}

/**
 * Every `lists:` URI that covers a list's, its own and each above it at a segment boundary, as
 * `lists:///inbox` and `lists:///inbox/groceries` for the latter, by R18's rule for a sub-resource.
 */
export function coveringListUris(uri: string): string[] {
  const segments = uri.slice(LISTS_SCHEME.length).split('/');
  return segments.map((_segment, index) => `${LISTS_SCHEME}${segments.slice(0, index + 1).join('/')}`);
}

/** The `lists:` URI of a list's path, as `lists:///inbox/groceries`, or undefined for any other path. */
export function listUri(path: string): string | undefined {
  const match = /^\/lists\/(?:(.+)\/)?list-([^/]+)$/.exec(path);
  // A list whose name is not a segment of its own, as `list-` or `list-..`, has no `lists:` URI.
  return match && SEGMENT.test(match[2]) ? `${LISTS_SCHEME}${match[1] ? `${match[1]}/` : ''}${match[2]}` : undefined;
}
