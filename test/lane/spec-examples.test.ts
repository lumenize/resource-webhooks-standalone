/// <reference types="vite/client" />
// The spec's own example messages, written by its authors, checked against the definition each
// one's folder names, as `ReadResourceRequest/read-resource-request.json` against
// `ReadResourceRequest`. They prove the validator reads schema.json as the spec means it.
import { describe, expect, it } from 'vitest';
import { specErrors } from '../../src/server-role/validation';

const examples = import.meta.glob('../../src/vendor/mcp-spec/2026-07-28/examples/*/*.json', { eager: true, import: 'default' });

function definitionOf(path: string): string {
  return path.split('/').at(-2)!;
}

describe("the spec's example messages", () => {
  it('include every one of the 129', () => {
    expect(Object.keys(examples)).toHaveLength(129);
  });

  it.each(Object.keys(examples).map((path) => [path.split('/examples/')[1], path]))('%s passes its definition', (_name, path) => {
    expect(specErrors(definitionOf(path), examples[path])).toEqual([]);
  });

  it('fail when a required member is removed', () => {
    const path = Object.keys(examples).find((p) => p.endsWith('/ReadResourceRequest/read-resource-request.json'))!;
    const request = structuredClone(examples[path]) as { params: Record<string, unknown> };
    delete request.params.uri;
    expect(specErrors('ReadResourceRequest', request)).not.toEqual([]);
    // The removed member fails only the method's own definition, not JSON-RPC's.
    expect(specErrors('JSONRPCRequest', request)).toEqual([]);
  });
});
