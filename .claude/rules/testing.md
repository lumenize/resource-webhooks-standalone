---
paths:
  - "**/*.test.ts"
  - "**/test/**"
  - "**/vitest.config.*"
---

# Tests

Before writing a test here, read `../lumenize/.claude/rules/testing.md`. Its philosophy applies: integration first, every test capable of failing, `vi.waitFor` over `setTimeout`, and letting time pass rather than starting a fixture in the lapsed state. The sections on the Mesh testing pyramid, lumenize's baseline test-app, `for-docs/` mini-apps and email waiters are Lumenize's.

`../lumenize/.claude/rules/live.md` states a principle that applies here even though its harness does not: ground claims in the running system. Here that means a deployed tier, because some claims, such as what a Worker's `fetch()` can reach, hold only on Cloudflare.
