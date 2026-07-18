# D1 dev server never becomes ready (open)

**Status:** unresolved. `npm run test:e2e-d1` fails; `npm run test:e2e` (SQLite,
4/4) and `npm run test:e2e-admin` (7/7) both pass.

Verified against vinext `1.0.0-beta.2`, Vite `8.1.5`, rolldown `1.2.0`,
Node `v26.3.1`, on 2026-07-18.

## Current symptom

`vinext dev` in the D1 test project dies during dependency optimization, so it
never prints the `Local: http://…:PORT/` banner `test/helpers.ts` waits for:

```
[vite] (ssr) [optimizer] bundling dependencies...
[vite] (rsc) [optimizer] bundling dependencies...

Error: Error during dependency optimization:
Build failed with 1 error:

[UNRESOLVED_IMPORT] Could not resolve './node.js' in node_modules/blake3-wasm/esm/index.js
    ╭─[ node_modules/blake3-wasm/esm/index.js:13:15 ]
 13 │ export * from './node.js';
    │ Help: 'node_modules/blake3-wasm/esm/index.js' is imported by the following path:
    │         - node_modules/blake3-wasm/esm/index.js
    │         - node_modules/wrangler/wrangler-dist/cli.js
```

`blake3-wasm`'s `./node.js` is a directory import that Rolldown can't resolve —
the reason `blake3-wasm` is in `OPTIMIZE_DEPS_EXCLUDE` in the first place.

## What is established

The failure reproduces reliably. Beyond that, **less than an earlier draft of
this document claimed** — see the retraction below before building on it.

A one-off `configResolved` dump in the D1 project suggested `wrangler` and
`blake3-wasm` were excluded in all three environments while the optimizer
bundled them anyway. A later reviewer could not reproduce that output, so
**treat "the excludes are reaching every environment" as unconfirmed** and
re-derive it before relying on it.

Open questions, best first:

1. **`@cloudflare/vite-plugin` calls `registerMissingImport` for every `node:*`
   specifier in dev** (`dist/index.mjs:75680-75684`), active only when
   `nodejs_compat` is set — i.e. only in the D1 project. That is a plausible
   mechanism for pulling unexpected modules into optimization, and it is the
   strongest untested lead.
2. **Which importer reaches `wrangler/wrangler-dist/cli.js`.** A bare
   `wrangler` exclude will not match a deep-path import. Check whether
   `@payloadcms/db-d1-sqlite` or the D1 template's `payload.config.ts`
   (`getPlatformProxy`) imports it by subpath.
3. Whether wrangler should be stubbed for RSC/SSR the way `drizzle-kit/api`
   already is in `RSC_STUBS` — it is a CLI, never evaluated at request time.

## Retracted

**An earlier revision of this document, and of the comment in
`src/optimize-deps.ts`, claimed vinext 1.0.0-beta.2 declares `optimizeDeps` on
no environment, and that this was the cause. That is false.** beta.2 declares
them on rsc (`dist/index.js:1307`), ssr (`:1330`) and client (`:1342`), inside
`if (hasAppDir)` at `:1289` — the structure moved from 0.1.3's 862/879/890, it
did not disappear.

The error came from `grep`: beta.2's `dist/index.js` is classified as binary
(`file` reports `data`), so `grep -c optimizeDeps` exits 1 with no output while
`grep -ac` reports 17. Empty output was read as "no declarations". **Use
`grep -a` on vinext's dist, or scan it from Node.**

Consequently the `configEnvironment` change in `payloadOptimizeDeps` is *not*
the fix for this bug — it is defensible on its own terms (it decouples us from
the framework's config shape and covers late-created environments) but the
`blake3-wasm` failure persisted after it, and the real cause is unestablished.

## Fixed along the way (do not re-investigate)

- **`payloadOptimizeDeps` now patches every environment** via
  `configEnvironment`, rather than only those that had already declared
  `optimizeDeps` when our `enforce: "pre"` `config` hook ran. This is a
  robustness change, **not** a fix for the failure above — see Retracted.
- **The e2e suite tested a stale build.** It installs the plugin from
  `pluginRoot`, but only `prepublishOnly` built it, which local folder installs
  never run — so runs tested whatever was last in `dist/`. Fixed with a
  `prepare` script.
- **The harness installed the wrong vinext.** `vinext` was installed unpinned
  and resolved to the `latest` dist-tag. Now pinned to `VERSIONS.vinext`.
- **vinext 1.0 changed `init`.** It now requires `--platform`, and the
  cloudflare target additionally requires `--cdn-cache`, `--data-cache`, and
  `--image-optimization`.

## Superseded

An earlier version of this document described a ~156s boot caused by ~11 rounds
of serial single-dependency optimizer discovery. **That pathology is gone on
vinext 1.0.0-beta.2** — current runs show 0 reload rounds. It was specific to
0.1.3 and should not be chased.

## Not established

- Whether D1 ever passed. No baseline exists from before 2026-07-18, and the
  harness pins only `payload` and `vinext` — `vite` and everything else float,
  so the project drifts without a commit touching it. Pinning `vite` in
  `VERSIONS` would make runs reproducible.

## Rejected approaches

- **Raising the `startDevServer` timeout.** Slow is a failure; the ceiling is
  not the bug.
- **Hardcoding discovered deps into an `optimizeDeps.include` list for the
  `rsc` env.** Papers over the cause and rots with every Payload release.
  Written and reverted; it also had no measurable effect.
