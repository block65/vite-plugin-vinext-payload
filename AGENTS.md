**Always:** Read `agent-standards/index.md` — follow all "Always load" standards listed there.
**Before writing or modifying TypeScript code:** STOP. Read `agent-standards/lang/typescript.md` and `agent-standards/lang/javascript.md` and follow them.
**Before writing or modifying tests:** STOP. Read `agent-standards/engineering/testing.md` and `agent-standards/engineering/vitest.md`. E2E tests here drive a real browser — also read `agent-standards/engineering/playwright.md`.
**Before writing a code comment:** Read `agent-standards/engineering/comments.md`.

## This repo

A Vite plugin that makes Payload CMS run under [vinext](https://github.com/cloudflare/vinext), including on Cloudflare Workers. It works by patching vinext and Payload internals at build time, so it is tightly coupled to exact upstream versions.

**The `vinext` peer dependency is pinned exactly** (`1.0.0-beta.2`, no `^` or `>=`). vinext is pre-1.0 in spirit — patch-level bumps move the internals this plugin patches. Never loosen the range.

**Patches are AST-based and version-fragile.** `src/` uses `@ast-grep/napi` against specific function shapes in vinext's dist output. Drift detectors in `test/patch-targets.test.ts` and `test/server-action-fix.test.ts` run the transforms against the _actually installed_ vinext and fail loudly when upstream moves. When one fails, the patch pattern needs updating — do not weaken the assertion to make it pass.

## Commands

This repo uses **pnpm** (see `packageManager` in `package.json`). Never `npm install` — it will produce a `package-lock.json` that conflicts with `pnpm-lock.yaml`.

- `pnpm test` — unit tests (fast, no network)
- `pnpm run test:e2e*` — e2e suites; each scaffolds a real project and boots a dev server. Slow (30s–2min), not run in CI. They run in a docker container (`scripts/e2e-container.sh`): the checkout is mounted read-only and the scaffold's installs — postinstall scripts included — execute only inside the container. Append `--host` to run directly on the host when debugging.
- `pnpm run lint` / `pnpm run fmt` — oxlint / oxfmt, scoped to the whole repo. Nothing is exempt.

## Releasing

**Changelog discipline:** every consumer-visible change (`feat:`, `fix:`, `perf:`) adds an entry to `CHANGELOG.md`'s Unreleased section _in the same commit_. Entries describe what a plugin user sees, not the diff — no dev-dep bumps, no internal refactors, and no fixes for regressions that never shipped in a release. If Unreleased is non-empty, prefer cutting a release when the work lands over letting changes accumulate — small releases keep "what changed" answerable.

Publishing is CI-only, via `.github/workflows/deploy.yml` on `release: published`:

1. Move the Unreleased section of `CHANGELOG.md` under a new version heading; bump `version` in `package.json` (edit directly, not `npm version`) — one commit.
2. `git push origin main`
3. `gh release create vX.Y.Z --notes "..."` — the notes are that changelog section verbatim; the tag comes from the release.

Never `npm publish` by hand — CI publishes with provenance. CI gates `lint`, `fmt:check` and `typecheck` only, so run the tests locally first.

On 0.x, breaking changes go in the **minor** position.
