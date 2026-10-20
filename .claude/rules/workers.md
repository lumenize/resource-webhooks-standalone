---
paths:
  - "**/*.ts"
  - "**/wrangler.jsonc"
---

# Writing Worker and Durable Object code

Before writing a Worker or a Durable Object here, read `../lumenize/.claude/rules/durable-objects.md`, `../lumenize/.claude/rules/raw-comm.md` and `../lumenize/.claude/rules/coding-style.md`. They are mostly about Cloudflare's platform and TypeScript, so they mostly apply. Skip what is about Mesh, Nebula, or lumenize's `apps/` and `packages/` layout.

If the task file adopts `@lumenize/mesh`, read `../lumenize/.claude/rules/mesh.md` as well, and take `raw-comm.md` only for the parts that bypass Mesh.
