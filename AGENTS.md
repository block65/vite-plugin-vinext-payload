**Always:** Read `agent-standards/index.md` — follow all "Always load" standards listed there.
**Before writing or modifying TypeScript code:** STOP. Read `agent-standards/lang/typescript.md` and `agent-standards/lang/javascript.md` and follow them.
**Before writing or modifying tests:** STOP. Read `agent-standards/engineering/testing.md` and `agent-standards/engineering/vitest.md`. E2E tests here drive a real browser — also read `agent-standards/engineering/playwright.md`.
**Before writing a code comment:** Read `agent-standards/engineering/comments.md`.

## This repo

A Vite plugin that makes Payload CMS run under [vinext](https://github.com/vinextjs/vinext), including on Cloudflare Workers. It works by patching vinext and Payload internals at build time, so it is tightly coupled to exact upstream versions.

**The `vinext` peer dependency is pinned exactly** (`1.0.0-beta.2`, no `^` or `>=`). vinext is pre-1.0 in spirit — patch-level bumps move the internals this plugin patches. Never loosen the range.

**Patches are AST-based and version-fragile.** `src/` uses `@ast-grep/napi` against specific function shapes in vinext's dist output. Drift detectors in `test/patch-targets.test.ts` and `test/server-action-fix.test.ts` run the transforms against the *actually installed* vinext and fail loudly when upstream moves. When one fails, the patch pattern needs updating — do not weaken the assertion to make it pass.

## Commands

This repo uses **pnpm** (see `packageManager` in `package.json`). Never `npm install` — it will produce a `package-lock.json` that conflicts with `pnpm-lock.yaml`.

- `pnpm test` — unit tests (fast, no network)
- `pnpm run test:e2e*` — e2e suites; each scaffolds a real project and boots a dev server. Slow (30s–2min), not run in CI.
- `pnpm run lint` / `pnpm run fmt` — oxlint / oxfmt, scoped to the whole repo. Nothing is exempt.

## Releasing

Publishing is CI-only, via `.github/workflows/deploy.yml` on `release: published`:

```
git push origin main
gh release create vX.Y.Z --notes "..."
```

Never `npm publish` by hand — CI publishes with provenance. Versions are bumped by editing `package.json` directly (not `npm version`); the tag comes from the release. CI gates only `lint` and `fmt:check`, so run the tests locally first.

On 0.x, breaking changes go in the **minor** position.
