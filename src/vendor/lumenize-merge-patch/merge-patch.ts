// Copied from @lumenize/structured-clone, packages/structured-clone/src/merge-patch.ts and
// preprocess.ts in lumenize/lumenize at commit 6689336, Copyright (c) 2025 Larry Maccherone, and
// relicensed here under Apache-2.0 by its author. Changes: `applyMergePatch` with the helpers it
// calls, and `setOwn` from preprocess.ts. The package's `diff`, which returns up to two patches for
// its encoding of Maps, Sets and arrays, is left behind, and `diff` below, for plain JSON, is this
// repo's own. Listed in ATTRIBUTIONS.md.

/** JSON-compatible value type. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** One RFC 7396 merge patch. */
export type MergePatch = JsonValue;

type JsonObject = { [k: string]: JsonValue };

/**
 * Applies one RFC 7396 merge patch to a target, without mutating it. Every key is data: reads are
 * own-property reads and writes define own properties, so a key named `__proto__` or
 * `constructor` patches like any other and touches no prototype.
 *
 * @throws TypeError for a value JSON cannot hold: an object whose prototype is
 *   neither `Object.prototype` nor `null`, such as a decoded `Date` or `Map`,
 *   or a function, bigint, symbol or `undefined`.
 */
export function applyMergePatch(target: JsonValue, patch: MergePatch): JsonValue {
  if (!isJsonObject(patch)) return deepClone(patch);
  const base: JsonObject = isJsonObject(target) ? { ...target } : {};
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    if (pv === null) {
      delete base[key];
    } else if (isJsonObject(pv)) {
      setOwn(base, key, applyMergePatch(Object.hasOwn(base, key) ? base[key] : {}, pv));
    } else {
      setOwn(base, key, deepClone(pv));
    }
  }
  return base;
}

// Writes an own data property. Assigning `__proto__` calls Object.prototype's
// setter, which replaces the target's prototype instead, so that one key is
// defined: it travels as the own key native structuredClone() keeps, and a
// payload naming it cannot hand the decoded object a prototype.
export function setOwn(target: Record<string, any>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

function isJsonObject(v: unknown): v is JsonObject {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`Not JSON: an object whose prototype is ${proto?.constructor?.name ?? 'not Object.prototype'}`);
  }
  return true;
}

// Refuses a value JSON cannot hold: a function, bigint, symbol or undefined.
function checkScalar(v: unknown): void {
  const type = typeof v;
  if (type === 'function' || type === 'bigint' || type === 'symbol' || type === 'undefined') {
    throw new TypeError(`Not JSON: a ${type}`);
  }
}

function deepClone<T extends JsonValue>(v: T): T {
  checkScalar(v);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deepClone(x)) as T;
  if (!isJsonObject(v)) return v;
  const out: JsonObject = {};
  for (const k of Object.keys(v)) setOwn(out, k, deepClone(v[k]));
  return out as T;
}

// What follows is this repo's own.

/**
 * What turns one plain JSON value into another: nothing, one merge patch, or the new value whole
 * when no patch can, since a merge patch reads a `null` member as a deletion and so cannot set one.
 */
export type Diff = { kind: 'same' } | { kind: 'patch'; patch: MergePatch } | { kind: 'full' };

/** The merge patch that turns `before` into `after`, by RFC 7396's reading of one. */
export function diff(before: JsonValue, after: JsonValue): Diff {
  if (holdsNullMember(after)) return { kind: 'full' };
  if (jsonEqual(before, after)) return { kind: 'same' };
  return { kind: 'patch', patch: patchAt(before, after) };
}

// An object is merged member by member, and anything else, an array included, replaced whole.
function patchAt(before: JsonValue, after: JsonValue): MergePatch {
  if (!isJsonObject(before) || !isJsonObject(after)) return deepClone(after);
  const patch: JsonObject = {};
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) setOwn(patch, key, null);
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key)) setOwn(patch, key, deepClone(after[key]));
    else if (!jsonEqual(before[key], after[key])) setOwn(patch, key, patchAt(before[key], after[key]));
  }
  return patch;
}

// A null inside an array is data, since a patch replaces an array whole, so only an object's
// members reached through objects count.
function holdsNullMember(value: JsonValue): boolean {
  if (!isJsonObject(value)) return false;
  return Object.values(value).some((member) => member === null || holdsNullMember(member));
}

// Plain JSON's equality: an object's members in any order, an array's in its own.
function jsonEqual(x: JsonValue, y: JsonValue): boolean {
  if (x === y) return true;
  if (Array.isArray(x) || Array.isArray(y)) {
    return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((item, index) => jsonEqual(item, y[index]));
  }
  if (!isJsonObject(x) || !isJsonObject(y)) return false;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((key) => Object.hasOwn(y, key) && jsonEqual(x[key], y[key]));
}
