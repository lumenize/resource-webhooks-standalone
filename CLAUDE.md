# Resource webhooks, standalone

A working prototype that lets an MCP client subscribe to a resource and hear about its changes by webhook. It is a standalone MCP extension: it has methods of its own, and borrows the webhook delivery design of the Events extension, [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), without using its `events/*` methods. Everything here is licensed Apache-2.0. The plan lives in `tasks/`.

The prototype's design leads, and the SEP is written beside it. It starts as numbered MUST, SHOULD and MAY notes in `sep-notes.md`, and becomes a draft later. This is the first of up to three flavors. One extending the Events extension and one amending it may follow, and the drafts are compared before one is chosen.

This repo sits next to `../lumenize` and borrows its guidance, because Larry's rules, skills and memories live there. This file says which parts apply here, so nothing specific to Lumenize leaks in.

## Imported from lumenize

These load every session:

@../lumenize/.claude/rules/critical.md
@../lumenize/.claude/rules/calibration.md
@../lumenize/.claude/rules/workflow.md
@../lumenize/.claude/rules/prose-voice.md

They were written for Lumenize. Read them with these exceptions:

- **`critical.md`** applies, except that docs do not live in `/website/docs/` here. This repo's docs are its README, its SEP notes and the drafts posted to the working group.
- **`calibration.md`**: the habits it corrects apply everywhere, though its evidence is all from Lumenize. §11 (Mesh shims), §12 (Vue templates), §14 (dominion) and §15 (Studio's agent) are about Lumenize code and have nothing to fire on here.
- **`workflow.md`** applies, except for its ADR index, its npm scripts and its Releases section, which belong to Lumenize.
- **`prose-voice.md`** applies to everything written here, and most of all to anything posted where the MCP community reads it. It loads only on matching paths in lumenize, which is too late for drafting, so it is imported here.

## Lumenize's ADRs do not bind here

The ADRs are commitments for Lumenize's codebase. This repo's readers are the MCP community, and its job is to show a proposal working, so the SEPs and the spec's own schema set the constraints. When an ADR's reasoning bears on a choice here, argue it on its merits in the task file's Decisions table, never cite it as binding.

ADR-001's principle holds here, because this repo chooses it. This is an independent implementation, not built on the official SDK. The spec's `schema.ts` is its only schema, and runtime validation is derived from those TypeScript types, with no zod and no hand-kept second copy. The repo also delivers TypeScript types for the extension, written in the spec's style.

## Licensing

Everything is Apache-2.0, which SEP-2133 requires of official extensions. The repo depends on no Lumenize package. Code it borrows from Lumenize, which Larry owns, is relicensed here under Apache-2.0, copied in with an attribution comment, and listed in `ATTRIBUTIONS.md`.

## Path-scoped rules

Lumenize's path-scoped rules cannot be linked in. A linked rule from outside the repo loads only if it has no `paths:` field. So `.claude/rules/` holds short local rules that load when you touch a matching file and say which lumenize rule to read.

## Skills

Linked from lumenize: `/write-task`, `/review-task`, `/build-task` and `/refactor-efficiently`. The Cloudflare skills come from `~/.claude/skills`.

- When a linked skill names a repo path that does not exist here, such as `tasks/README.md`, read it from `../lumenize/`. New files the skill writes, a task archive included, go in this repo.
- Run the prose checker as `node ../lumenize/scripts/check-prose.mjs <file>`.
- `/review-task`'s product lens is not Lumenize's `docs/vision/`. Here it is the SEPs, the charter of the Tasks and Events working group (named Triggers & Events until 2026-10-16), and what earns standing with the working group. The task file's design intent states it.
- Not linked: `/live`, `/nightly-pass` and `/release-workflow`, which drive Lumenize's systems; the doc-example skills, which are for Lumenize's website; and `/task-management`, because work here is always task-file-first.

## Sibling repos

- `../mcp-events-prototype` is the earlier prototype, of a state contract carried over SEP-3415's Events. Its task files, as committed in 79a927d, are this repo's mining source. They stay untouched until a mining pass gives each piece a fate: carried, superseded or dropped on purpose. Read them for facts when needed, and say so when an idea is carried from them.
- `../experimental-ext-triggers-events` is the fork of the Tasks and Events working group's repo, still named for Triggers & Events (origin `lumenize/experimental-ext-triggers-events`, with `upstream`). The proposal goes there later, on the `resource-webhooks` branch, as `proposals/XXXX-resource-webhooks.md`, for a PR to that repo. The formal SEP follows in `../modelcontextprotocol`.
- `../modelcontextprotocol` is the fork for SEP PRs (origin `lumenize/modelcontextprotocol`, with `upstream`).
- `../mcp-typescript-sdk` is the fork for SDK PRs (origin `lmaccherone/mcp-typescript-sdk`). An Extensions Track SEP needs a reference implementation in an official SDK before review, and that goes there. It is far behind upstream, so sync it before branching.
- `../lumenize` is where the guidance above lives. Do not edit it from here unless Larry asks.

In a sibling fork, follow that repo's own CLAUDE.md and tooling. The TypeScript SDK uses pnpm, and `critical.md`'s npm-only rule is for repos Larry owns, not for upstream forks.

This repo has no remote yet. Its remote will be the public `lumenize/resource-webhooks-standalone`, created when Larry asks. Pushing publishes, so push only when Larry asks.
