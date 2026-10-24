**Always:** Read `agent-standards/index.md` — follow all "Always load" standards listed there.
**Before writing or modifying TypeScript code:** STOP. Read `agent-standards/lang/typescript.md` and `agent-standards/lang/javascript.md` and follow them.
**Before writing or modifying tests:** STOP. Read `agent-standards/engineering/testing.md` and `agent-standards/engineering/vitest.md`. E2E tests here drive a real browser — also read `agent-standards/engineering/playwright.md`.
**Before writing a code comment:** Read `agent-standards/engineering/comments.md`.

## This repo

A Vite plugin that makes Payload CMS run under [vinext](https://github.com/cloudflare/vinext), including on Cloudflare Workers. It configures vinext's Vite environments and rewrites third-party code at build time (React's RSC serializer, undici, Payload's dependencies), so it is tightly coupled to exact upstream versions.

**The `vinext` peer dependency is pinned exactly** in `package.json` — no `^`, no `>=`. vinext releases move the environment and optimizeDeps setup this plugin configures. Never loosen the range.

**Patches are version-fragile.** Every rewrite is declared in `PATCH_MANIFEST` (`src/main.ts`). The AST patches (`@ast-grep/napi`) match function shapes in undici and `react-server-dom-webpack`; a pattern that stops matching makes its patch a silent no-op. `test/patch-targets.test.ts` checks targets in the installed vinext's dist that no current patch uses. When a drift assertion fails, update the patch pattern — do not weaken the assertion to make it pass.

## Commands

This repo uses **pnpm** (see `packageManager` in `package.json`). Never `npm install` — it will produce a `package-lock.json` that conflicts with `pnpm-lock.yaml`.

- `pnpm test` — unit tests (fast, no network)
- `pnpm run test:e2e*` — e2e suites; each scaffolds a real project and boots a dev server. Slow (30s–2min), not run in CI. They run in a docker container (`scripts/e2e-container.sh`): the checkout is mounted read-only and the scaffold's installs — postinstall scripts included — execute only inside the container. Append `--host` to run directly on the host when debugging.
- `pnpm run lint` / `pnpm run fmt` — oxlint / oxfmt, scoped to the whole repo. Nothing is exempt.

## Releasing

**Changelog discipline:** every consumer-visible change (`feat:`, `fix:`, `perf:`) adds an entry to `CHANGELOG.md`'s Unreleased section _in the same commit_. Entries describe what a plugin user sees, not the diff — no dev-dep bumps, no internal refactors, and no fixes for regressions that never shipped in a release. If Unreleased is non-empty, prefer cutting a release when the work lands over letting changes accumulate — small releases keep "what changed" answerable.

Publishing is CI-only, via `.github/workflows/deploy.yml` on `release: published`:

1. Cut the Unreleased entries from `CHANGELOG.md` (leave the empty section); bump `version` in `package.json` (edit directly, not `npm version`) — one commit.
2. `git push origin main`
3. `gh release create vX.Y.Z --notes "..."` — the notes are the cut entries verbatim; the tag comes from the release. Released history lives in GitHub releases, not the file.

Never `npm publish` by hand — CI publishes with provenance. CI gates `lint`, `fmt:check` and `typecheck` only, so run the tests locally first.

On 0.x, the **minor** position is the major bump — `0.3.1` to `0.4.0` is a
breaking release, not a feature one. Treat it with that weight.
