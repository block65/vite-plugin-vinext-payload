# D1 dev server never becomes ready (RESOLVED 2026-07-18)

**Status:** resolved. `npm run test:e2e-d1` passes 5/5 from a clean scaffold
(304s), alongside `test:e2e` (SQLite, 4/4) and `test:e2e-admin` (7/7).

Resolved against vinext `1.0.0-beta.2`, Vite `8.1.5`, rolldown `1.2.0`,
Node `v26.3.1`, payload `3.82.1`.

## What it was — two stacked causes

**1. The D1 project never had the plugin.** `vite-plugin-vinext-payload init`
located `vinext()` in the plugins array with the ast-grep pattern `vinext()`,
which only matches a *zero-argument* call. vinext 1.0's own
`init --platform=cloudflare` writes `vinext({ cache: { cdn: cdnAdapter() } })`,
so our matcher found nothing, reported a quiet
"skipped (could not find vinext() in plugins array)", and exited 0. Every D1
run since the 1.0 bump therefore exercised vinext *without*
`payloadPlugin()` — none of our excludes, stubs, or externals were in the
pipeline at all. Fixed by matching `vinext($$$ARGS)`; guarded by a new unit
fixture (`viteConfigVinextArgs`) and an e2e assertion that the config
contains `payloadPlugin()` after init.

**2. wrangler was reachable from the module graph.** The D1 template's
`payload.config.ts` (as rewritten by our init) contains:

```ts
try {
  const { env } = await import(/* @vite-ignore */ 'cloudflare:workers')
  return env
} catch {
  const { getPlatformProxy } = await import('wrangler')  // ← this
  ...
}
```

The fallback only ever *executes* under plain Node (payload CLI), but the
import must still *resolve* in every Vite environment that processes the
config. Bundling or optimizer-scanning `wrangler` pulls in its entire CLI —
including `blake3-wasm`, whose `export * from './node.js'` Rolldown cannot
resolve. In dev that killed dependency optimization
(`[UNRESOLVED_IMPORT] Could not resolve './node.js'`); the same chain failed
`vinext build` outright:

```
node_modules/blake3-wasm/esm/index.js
← node_modules/wrangler/wrangler-dist/cli.js
← src/payload.config.ts
← src/app/my-route/route.ts
← \0virtual:vinext-rsc-entry
← \0virtual:cloudflare/worker-entry
```

`wrangler` was already in `SSR_EXTERNAL` and `OPTIMIZE_DEPS_EXCLUDE`, but
neither mechanism reaches the cloudflare worker build. Fixed by stubbing
`wrangler` in `payloadCliStubs` (a `getPlatformProxy` that throws on call,
not on import — a genuine Node-side use stays loud).

Cause 1 is why cause 2 was so confusing: with the plugin absent, no exclude
or stub we wrote could have any effect, which made the excludes look broken.

## Retracted (kept for the record)

An earlier revision claimed vinext 1.0.0-beta.2 declares `optimizeDeps` on no
environment. **False** — beta.2 declares them on rsc/ssr/client
(`dist/index.js:1307/:1330/:1342`, inside `if (hasAppDir)` at `:1289`). The
error came from `grep`: beta.2's `dist/index.js` is classified as binary
(`file` reports `data`), so `grep -c` exits silently while `grep -ac` reports
17 hits. **Use `grep -a` on vinext's dist, or scan it from Node.**

Consequently the `configEnvironment` change in `payloadOptimizeDeps` was not
a fix for this bug — it is defensible on its own terms (covers late-created
environments) but unrelated to the failure.

## Fixed along the way (do not re-investigate)

- **The e2e suite tested a stale build.** Only `prepublishOnly` built the
  plugin, which local folder installs never run. Fixed with `prepare`.
- **The harness installed the wrong vinext.** Unpinned install resolved to
  the `latest` dist-tag. Now pinned to `VERSIONS.vinext`; `vite` is now also
  pinned (`VERSIONS.vite`).
- **vinext 1.0 changed `init`.** Requires `--platform`; the cloudflare target
  additionally requires `--cdn-cache`, `--data-cache`, `--image-optimization`.

## Superseded

An earlier version described a ~156s boot from ~11 rounds of serial optimizer
discovery on 0.1.3. Gone on 1.0.0-beta.2; do not chase.

## Historical note

Whether D1 ever passed before 2026-07-18 was never established — but given
cause 1 dates to the vinext 1.0 config shape, the suite could not have
meaningfully passed on 1.0.0-beta.2 before the init fix.
