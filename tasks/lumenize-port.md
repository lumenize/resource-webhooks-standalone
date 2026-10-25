# Porting resource webhooks to Lumenize

**Status:** Notes, not a task file yet. They began in the predecessor, `../mcp-events-prototype` at 79a927d, on 2026-10-17 to 2026-10-19, and were revised for this design at its mining pass on 2026-10-25. When the port starts, this file moves into Lumenize's `tasks/` as the seed of a real task file. It holds the notes for the Lumenize port item in [master-plan.md](master-plan.md) § *Future state*.

## What carries over

- **The conventions, into Lumenize's own subscriptions:** a version compared only for equality, coalescing per resource while a delivery is pending, a deletion delivered as a version of its own, a collection's change cursor that moves only on refresh results, a catch-up form the caller picks with `catchUp`, and the three forms, `notify`, `full` and `patch`.
- **Each Lumenize Resource is exposed as an MCP resource.** A resource's URI and contents are what this design syncs, so a Lumenize Resource maps onto one directly.
- **The server's shape.** `routeDORequest` carries a request to its object, `onBeforeRequest` and `onBeforeConnect` check tokens at the edge, and a table of handlers keyed by JSON-RPC method name is bundled for scoped mesh nodes.
- **The server role goes first.** The prototype's `Server` role module is adopted into Lumenize before anything else, and its `Gateway` role maps onto Lumenize's `ClientGateway`.
- **The role modules run over Mesh.** The server role takes parsed JSON-RPC messages, and the gateway role takes a delivery's headers and raw bytes, since SEP-3415 signs the bytes as received, so the port can compose either into a Lumenize node with no `Request` involved.
- **A JSON Schema per type, in each resource template's `_meta`.** The port adds one, so a client checks its own inputs, such as a UI's, against the same schema the server enforces, before it sends them (Larry, 2026-10-25).

## What changes in the port

- **Structured-clone is required, not offered.** It becomes a preprocess callback with merge patch downstream of it, and Lumenize refuses a client that has not declared it. The prototype sends plain JSON only.
- **Values get their schema another way.** The prototype generates each type's JSON Schema from its TypeScript with the spec's generator. Lumenize validates values with `@lumenize/ts-runtime-parser-validator`, and the port also emits the JSON Schema each template carries.
- **Positions need work; versions do not.** § *Versions and positions* has the detail.
- **Pruning.** The prototype writes a deletion as a row marked deleted, as Lumenize's soft delete does, but it drops rows older than its cut-off window. So a cursor older than the window gets a reset (sep-notes R34), and a deletion it has forgotten answers at a base version (R37). Lumenize never deletes history (Larry, 2026-10-19), so it never prunes, never resets, and never forgets a deletion.
- **Routing.** The prototype vendors a copy of `routeDORequest` in `src/vendor/lumenize-routing/`, so its `fetch` handler reads as the port's would, with only the import changed to `@lumenize/routing`.
- **Merge patch.** The prototype copies `applyMergePatch` and writes a plain-JSON `diff`; in Lumenize both stay structured-clone's own. Lumenize's encoding writes `null` as `{"$type":"null"}`, so its patches carry `null` as data while the patch layer stays plain RFC 7396, and the prototype's closed schemas, which refuse a `null` member, have no counterpart. When its `diff` returns two patches, for a reordered Map, Set or array, SQLite applies them as two `json_patch` calls in a row.

## Versions and positions

**Lumenize already keeps versions and positions apart, so this design fits it with no change to versions.** Checked against `packages/resources/src/snapshots.ts` on 2026-10-19:

- **Its version meets sep-notes R3 and R4.** A write's `newETag` is a UUID the client generates, or `crypto.randomUUID()` on the server's own writes, and it becomes the `eTag` of every resource the write touches. Clients compare it only for equality, and it doubles as an idempotency key. The prototype's server mints its own versions instead, and its `write_note` takes an optional `version` precondition, so the replay check below is Lumenize's alone.
- **Its replay check.** `transaction` treats a write as a replay when a resource's current `eTag` already equals the write's `newETag`, and checks that before it checks for an `eTag` conflict.
- **The ISO string is `validFrom`, which is a time.** `#calculateValidFrom` starts from `Date.now()`, and when that is not later than a written resource's current `validFrom`, moves it to that `validFrom` plus 1 ms. In the prototype, the stamp from one counter across the server plays this role.

**Two things stop `validFrom` from serving as a collection's change cursor today:**

1. **It orders each resource, not the whole object.** The bump compares only the resources in the same write, so two resources written by separate writes in one millisecond share a `validFrom`. Sorting by `(validFrom, resourceId)`, as `enumerateCurrentByField` does, can then disagree with commit order. Say B commits at `2026-10-19T15:00:00.000Z` and A commits after it, in the same millisecond: the sort puts A first, so a client holding B's position asks for what changed after `(…00.000Z, B)` and never hears of A. A cursor needs one commit order across every resource a subscription covers.
2. **History coalescing leaves `validFrom` where it was.** A write by the same actor within `coalesceWindowMs`, an hour by default, overwrites the current row in place and keeps its `validFrom`, so a cursor at that `validFrom` would miss the overwrite. Every write needs a new position, even when it reuses a row.

**Two fixes cover both, to choose between when the port starts:**

- **Make `validFrom` the position.** Bump it above the object's latest `validFrom` rather than the write's own resources, and move a coalesced row's `validFrom` forward when it is overwritten, which also makes the coalescing window slide.
- **Keep a position apart from `validFrom`**, as the prototype does with its stamps, in a column of its own.

Larry predicted on 2026-10-17 that ordering positions on the server would cost Lumenize more than what it does now. Either fix is where that cost lands.

**A cursor can be the `eTag` of the last change a subscription covers** (Larry, 2026-10-19). sep-notes R36 lets a server make a cursor and a version one value only when both come from one ordered counter, which a UUID is not, but an opaque cursor that Lumenize resolves to a position through an index on `eTag` is still legal (R32). Both gaps above still apply, and an `eTag` that history coalescing overwrote in place can no longer be found, so a cursor naming it gets a reset (R34).

**An occurrence's `timestamp` is its write's commit time,** for level 1's Events occurrences only, since a `ResourceChange` carries no timestamp. It equals `validFrom`, except after an in-place coalesced write, whose row keeps the earlier time.
