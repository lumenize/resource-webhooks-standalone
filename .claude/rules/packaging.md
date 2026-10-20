---
paths:
  - "**/package.json"
  - "package-lock.json"
  - "**/wrangler.jsonc"
  - "**/tsconfig*.json"
  - "**/vitest.config.*"
  - ".dev.vars*"
  - ".nvmrc"
---

# Packaging, environment and secrets

Before changing one of these files, read `../lumenize/.claude/rules/packaging.md`. The generated global `Env`, environment variables and secrets, the lockfile, startup cost and toolchain bumps all apply. Its development-mode `package.json` and the publish flow that repoints `src/` to `dist/` belong to lumenize's Lerna release.

Secrets for this repo go in its own gitignored `.dev.vars`. Do not symlink lumenize's, which holds far more than this repo needs.
