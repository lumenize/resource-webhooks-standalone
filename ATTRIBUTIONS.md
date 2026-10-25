# Attributions

Everything in this repository is licensed under Apache-2.0. These files are copied or adapted from elsewhere, and each carries a comment saying so.

## From Lumenize

Larry Maccherone wrote these and owns their copyright, published them under the MIT License, and relicenses these copies under Apache-2.0. The routing files are copied from [lumenize/lumenize](https://github.com/lumenize/lumenize) at commit `c1bb1b12`.

- **`src/json-rpc.ts`** is adapted from `json-rpc-mixin` 0.0.6, as its repository stood at commit `ce22f98`, one version past the 0.0.5 [on npm](https://www.npmjs.com/package/json-rpc-mixin): its processing core and its error-to-status mapping, without zod, `agents`, dispatch by reflection, batches or its WebSocket envelope. `test/lane/mcp-core.test.ts` carries over its tests of the JSON-RPC 2.0 specification's examples.
- **`src/vendor/lumenize-routing/`**, six files from `packages/routing/src/` of `@lumenize/routing` 0.26.0: `route-do-request.ts`, `parse-pathname.ts`, `get-do-namespace-from-path-segment.ts`, `get-do-stub.ts`, `is-do-namespace.ts` and `is-durable-object-id.ts`. `route-do-request.ts` has its `@lumenize/debug` logging removed, and the other five are unchanged.

## From the MCP specification

Adapted from [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) at commit `dae694f6`, whose license is moving from MIT to Apache-2.0, as its `LICENSE` file describes.

- **`src/vendor/mcp-spec/2026-07-28/`** holds `schema/2026-07-28/schema.ts`, `schema.json` and the 129 files of `examples/`, copied unchanged except for a two-line header on `schema.ts`.
- **`scripts/generate-schemas.mjs`** follows `scripts/generate-schemas.ts`: the same `typescript-json-schema` flags, the same rewrite to JSON Schema 2020-12, and the same `--check` comparison.
