// Matching a URI against a template, for a `uriTemplate` target (R19). RFC 6570 defines expanding
// a template, not matching one, so A matches a simple `{name}` as exactly one path segment and a
// reserved expansion `{+name}` as one or more characters, slashes included, and refuses a template
// with any other expression. A template covers each URI it matches and every URI under one.

/** A test of whether a template covers a URI, or undefined for a template A does not match. */
export function templateMatcher(template: string): ((uri: string) => boolean) | undefined {
  let pattern = '';
  let rest = template;
  for (;;) {
    const open = rest.indexOf('{');
    const literal = open === -1 ? rest : rest.slice(0, open);
    if (literal.includes('}')) return undefined;
    pattern += literal.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
    if (open === -1) break;
    const close = rest.indexOf('}', open);
    if (close === -1) return undefined;
    const expression = rest.slice(open + 1, close);
    if (/^[A-Za-z0-9_]+$/.test(expression)) pattern += '[^/]+';
    else if (/^\+[A-Za-z0-9_]+$/.test(expression)) pattern += '.+';
    else return undefined;
    rest = rest.slice(close + 1);
  }
  const covers = new RegExp(`^${pattern}(?:/.*)?$`);
  return (uri) => covers.test(uri);
}
