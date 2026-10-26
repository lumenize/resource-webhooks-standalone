// Which of A's paths name a resource and which a folder. A path is relative to A's root, as
// `/notes/inbox/note-42` under `https://….workers.dev/server/A`.

export const TYPES = {
  notes: { singular: 'note', definition: 'Note', shape: '{ title, done?, due? }' },
  lists: { singular: 'list', definition: 'List', shape: '{ title, items }' },
} as const;

export type TypeName = keyof typeof TYPES;

// A path segment uses only URL-unreserved characters, so no URI A serves needs escaping.
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
