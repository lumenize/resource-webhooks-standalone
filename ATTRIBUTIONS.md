# Attributions

Everything in this repository is licensed under Apache-2.0. These files are copied or adapted from elsewhere, and each carries a comment saying so.

## From Lumenize

Copied from [lumenize/lumenize](https://github.com/lumenize/lumenize) at commit `c1bb1b12`. Larry Maccherone wrote them and owns their copyright, published them under the MIT License, and relicenses these copies under Apache-2.0.

- **`src/vendor/lumenize-routing/`**, six files from `packages/routing/src/` of `@lumenize/routing` 0.26.0: `route-do-request.ts`, `parse-pathname.ts`, `get-do-namespace-from-path-segment.ts`, `get-do-stub.ts`, `is-do-namespace.ts` and `is-durable-object-id.ts`. `route-do-request.ts` has its `@lumenize/debug` logging removed, and the other five are unchanged.

## From the MCP specification

Adapted from [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) at commit `dae694f6`, whose license is moving from MIT to Apache-2.0, as its `LICENSE` file describes.

- **`scripts/generate-schemas.mjs`** follows `scripts/generate-schemas.ts`: the same `typescript-json-schema` flags, the same rewrite to JSON Schema 2020-12, and the same `--check` comparison.
