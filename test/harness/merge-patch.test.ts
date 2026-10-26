// The copied applyMergePatch and this repo's plain-JSON diff, which no request reaches whole: A's
// closed schemas refuse an unknown member, a `__proto__` key among them.
import { describe, expect, it } from 'vitest';
import { applyMergePatch, diff, type JsonValue } from '../../src/vendor/lumenize-merge-patch/merge-patch';

// RFC 7396 Appendix A, as lumenize's own conformance test copies it.
const APPENDIX_A: { original: JsonValue; patch: JsonValue; result: JsonValue }[] = [
  { original: { a: 'b' }, patch: { a: 'c' }, result: { a: 'c' } },
  { original: { a: 'b' }, patch: { b: 'c' }, result: { a: 'b', b: 'c' } },
  { original: { a: 'b' }, patch: { a: null }, result: {} },
  { original: { a: 'b', b: 'c' }, patch: { a: null }, result: { b: 'c' } },
  { original: { a: ['b'] }, patch: { a: 'c' }, result: { a: 'c' } },
  { original: { a: 'c' }, patch: { a: ['b'] }, result: { a: ['b'] } },
  { original: { a: { b: 'c' } }, patch: { a: { b: 'd', c: null } }, result: { a: { b: 'd' } } },
  { original: { a: [{ b: 'c' }] }, patch: { a: [1] }, result: { a: [1] } },
  { original: ['a', 'b'], patch: ['c', 'd'], result: ['c', 'd'] },
  { original: { a: 'b' }, patch: ['c'], result: ['c'] },
  { original: { a: 'foo' }, patch: null, result: null },
  { original: { a: 'foo' }, patch: 'bar', result: 'bar' },
  { original: { e: null }, patch: { a: 1 }, result: { e: null, a: 1 } },
  { original: [1, 2], patch: { a: 'b', c: null }, result: { a: 'b' } },
  { original: {}, patch: { a: { bb: { ccc: null } } }, result: { a: { bb: {} } } },
];

// The predecessor's extra cases: new keys' order, a nested null under a missing key, roots that are
// not objects, and numbers and escapes.
const EXTRA: { before: JsonValue; after: JsonValue }[] = [
  { before: { a: 1 }, after: { a: 1, c: 3, b: 2 } },
  { before: {}, after: { a: {} } },
  { before: 'x', after: { a: { b: 1 } } },
  { before: { a: 1 }, after: [1, null, { b: null }] },
  { before: [1], after: 2 },
  { before: { a: 1 }, after: null },
  { before: { n: 1 }, after: { n: 1e21, m: -0.5, s: 'line sep "quoted" \\ back', u: '😀\u0000' } },
];

describe('applyMergePatch', () => {
  it.each(APPENDIX_A.map((vector, index) => [index + 1, vector] as const))('gives RFC 7396 Appendix A vector %i its result', (_number, { original, patch, result }) => {
    expect(applyMergePatch(original, patch)).toEqual(result);
  });

  it('patches a __proto__ key as that member\'s data, and leaves every prototype alone', () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"x": 1}}}') as JsonValue;
    const result = applyMergePatch({}, patch) as Record<string, unknown>;
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(result, 'constructor')).toBe(true);
  });
});

describe('diff, then applyMergePatch', () => {
  const vectors = [...APPENDIX_A.map(({ original, result }) => ({ before: original, after: result })), ...EXTRA];

  it.each(vectors.map((vector, index) => [index + 1, vector] as const))('gives back the new value for case %i, or answers full', (_number, { before, after }) => {
    const found = diff(before, after);
    if (found.kind === 'full') {
      // Only a value with a null object member, which no merge patch can set, goes whole.
      expect(JSON.stringify(after)).toMatch(/:null/);
      return;
    }
    expect(applyMergePatch(before, found.kind === 'same' ? {} : found.patch)).toEqual(after);
  });

  it("keeps new keys in the new value's order, and answers same for an equal value in another order", () => {
    const found = diff({ a: 1 }, { a: 1, c: 3, b: 2 });
    expect(found).toEqual({ kind: 'patch', patch: { c: 3, b: 2 } });
    expect(JSON.stringify(applyMergePatch({ a: 1 }, (found as { patch: JsonValue }).patch))).toBe('{"a":1,"c":3,"b":2}');
    expect(diff({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual({ kind: 'same' });
  });

  it('answers full for a value whose object holds a null member, and patches one whose array holds a null', () => {
    expect(diff({ a: 1 }, { a: 1, e: null })).toEqual({ kind: 'full' });
    expect(diff({ a: [] }, { a: [null] })).toEqual({ kind: 'patch', patch: { a: [null] } });
  });
});
