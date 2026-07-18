# D1 dev server never becomes ready (open)

**Status:** unresolved. `npm run test:e2e-d1` fails; `npm run test:e2e` (SQLite) passes.

## Symptom

`vinext dev` in the D1 test project never prints the `Local: http://…:PORT/`
banner that `test/helpers.ts` waits for, so `startDevServer` times out at 60s
and all 5 D1 tests skip.

It is not hung. Left alone, the banner does arrive — measured at **156s** on a
local laptop. That is a failure, not a slow success; the server should be
usable in a fraction of that.

## Where the time goes

Not one stall. The boot is ~11 repetitions of this cycle:

```
[vite] (rsc) [optimizer] bundling dependencies...     ← 5–9s
[vite] (rsc) ✨ new dependencies optimized: <ONE dep>
[vite] (rsc) ✨ optimized dependencies changed. reloading
```

Each round discovers a **single** new dependency, re-bundles, and reloads,
which triggers the next discovery. Serial, one dep per round.

Deps discovered this way, in order, over a full 156s boot:

```
react-server-dom-webpack/static.edge, @lexical/rich-text, @lexical/utils,
lexical, escape-html, bson-objectid, payload/shared, @lexical/list, uuid,
jsox, @lexical/headless, @lexical/html, qs-esm, @lexical/table, date-fns,
dequal/lite, path-to-regexp, @payloadcms/translations, payload/internal,
react-dom/server
```

## The key contrast

The **SQLite project boots with 0 optimizer reload rounds** and passes in ~91s
total. Same plugin, same `rsc` environment, same Payload dep graph.

The projects' Vite configs differ by exactly one thing:

```diff
  export default defineConfig({
-   plugins: [vinext(), payloadPlugin()],
+   plugins: [
+     cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
+     vinext(),
+     payloadPlugin(),
+   ],
  });
```

So under `@cloudflare/vite-plugin` the `rsc` environment runs inside workerd,
and something about that path appears to defeat the optimizer's up-front scan,
leaving deps to be discovered lazily one request at a time. **This is the
hypothesis to test first** — it is inferred from the config delta and the
round counts, not confirmed.

Suggested next step: dump the resolved `environments.rsc.optimizeDeps` (and
whether a scan phase runs at all) in both projects and diff them.

## Ruled out

- **Not caused by dep updates.** Reproduced with vite pinned back to 8.0.16
  inside the test project.
- **Not the stale-`dist` bug.** Before 2026-07-18 the e2e suite installed the
  plugin from `pluginRoot` without ever building it, so it tested a June 15
  artifact (`prepare` script now added). Reproduced after a correct build.
- **Not the vinext pin bug.** `test/helpers.ts` used to install `vinext`
  unpinned and silently picked up `1.0.0-beta.2`; that produced a different,
  earlier failure (`vinext init needs a deployment target`) and is fixed.

## Not established

- Whether this ever passed. No baseline exists from before 2026-07-18, and the
  harness pins only `payload` and `vinext` — `vite` and everything else float,
  so the project can drift without a commit touching it. Pinning `vite` in
  `VERSIONS` would make runs reproducible.
- Whether the serial discovery is caused by duplicate/nested copies of the
  listed packages resolving differently from the bare specifier.

## Rejected approaches

- **Raising the `startDevServer` timeout.** Makes the suite green while leaving
  a 156s dev boot in place. Slow is a failure.
- **Hardcoding the discovered deps into an `optimizeDeps.include` list for the
  `rsc` env.** Papers over the cause, and the list would rot with every Payload
  release. Was written and reverted.
