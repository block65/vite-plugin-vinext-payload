# Internals — sub-plugins and what they work around

This doc is for people hacking on the plugin (or on vinext / Payload
compatibility). If you just want to *use* Payload on vinext, the
[README](../README.md) is all you need.

`payloadPlugin()` composes a set of sub-plugins, each working around a
specific upstream bug. They are not exported individually — the split exists
purely for readability and maintenance. See
[`upstream-bugs.md`](upstream-bugs.md) for the full write-up of each bug,
including what Next.js does differently.

## Sub-plugins

| Plugin | Owner bug | What it does |
| --- | --- | --- |
| `payloadUseClientBarrel` | Payload | Auto-detects `@payloadcms/*` barrel files that re-export from `'use client'` modules and excludes them from RSC pre-bundling (pre-bundling strips the directive, breaking client references) |
| `payloadServerExternals` | Vite | Externalizes packages from both `ssr` and `rsc` environments. Only build tools and native addons are externalized (workerd can't resolve externals at runtime). Uses `configEnvironment` because `ssr.external` only applies to the `ssr` environment, and writes to `build.rolldownOptions.external` because `@cloudflare/vite-plugin` rejects `resolve.external` |
| `payloadWorkerdCompat` | workerd / Rolldown | Four module-resolution / bundle-time fixes needed before code can evaluate inside workerd: (1) `resolveId` fallback for `node:*` CJS requires that bypass `@cloudflare/vite-plugin`'s filtered hook, (2) try-catch wrapper for undici's `detectRuntimeFeatureByExportedProperty` which crashes due to Rolldown's CJS→ESM interop returning void, (3) `import.meta.url ?? "file:///"` guards for `fileURLToPath` / `createRequire` patterns that crash in bundled workerd asset chunks, (4) `console.createTask` polyfill — where workerd exposes the method (e.g. when `node:console` is in the module graph) it throws "not implemented", breaking React 19 dev mode's async stack traces. Injected via both Vite transform and optimizeDeps rolldown plugin to cover pre-bundled deps |
| `payloadWorkerdEntry` | Rolldown / @cloudflare/vite-plugin | `generateBundle` hook that re-wraps the RSC entry default export in `{ fetch }` if Rolldown inlines vinext's Workers handler wrapper into a bare function (regression of [workers-sdk#10213](https://github.com/cloudflare/workers-sdk/issues/10213) on Vite 8/Rolldown). Defensive on vinext 1.0.0-beta.2: a verified real build already emits a `{ fetch }` object there, and the injected wrapper passes non-functions through untouched |
| `payloadHtmlDiffExportFix` | @vitejs/plugin-rsc / Rolldown | Patches `@payloadcms/ui/dist/exports/rsc/index.js` at build start to stabilize `getHTMLDiffComponents` export when RSC/Rolldown reports it as missing in latest templates |
| `payloadOptimizeDeps` | vinext | Per-environment optimizeDeps: excludes problematic packages, force-includes CJS transitive deps for the client. Auto-discovers all `next/*` alias specifiers from the resolved config so the optimizer doesn't discover them at runtime (which causes a full page reload) |
| `payloadCjsTransform` | Vite | Fixes `this` → `globalThis` in UMD/CJS wrappers and wraps `module.exports` with ESM scaffolding (skips React/ReactDOM which Vite 8 handles natively) |
| `payloadCliStubs` | Payload | Stubs packages not needed at web runtime (`console-table-printer`, `json-schema-to-typescript`, `esbuild-register`, `ws`, `wrangler`). The `wrangler` stub is what keeps payload.config's Node-only `getPlatformProxy` fallback from dragging wrangler's entire CLI — including the unresolvable `blake3-wasm` — into workerd bundles |
| `payloadNavComponentFix` | Payload | Patches `DefaultNavClient` and `DocumentTabLink` to not switch element types (`<a>` vs `<div>`) based on `usePathname()`/`useParams()` — prevents React 19 tree-destroying hydration mismatches (AST-based via ast-grep) |
| `payloadRscExportFix` | @vitejs/plugin-rsc | Fixes `@vitejs/plugin-rsc`'s CSS export transform dropping exports after sourcemap comments |
| `payloadRscRuntime` | vinext / workerd / pnpm | RSC environment patches: stubs `file-type` (a direct dep of `payload` itself) and `drizzle-kit/api` (via `@payloadcms/db-d1-sqlite`), and patches the RSC serializer to silently drop non-serializable values (functions, RegExps) at the server/client boundary. Next.js prod throws the same serialization error — dropping is a deliberate divergence that keeps Payload's admin form flows working |
| `payloadServerActionFix` | vinext | Prevents data-returning server actions (like `getFormState`) from triggering a re-render that resets Payload's form state. Shape depends on vinext version: on ≤0.0.46, moves `getReactRoot().render()` after the `returnValue` check in `app-browser-entry`; on 0.0.47–0.0.55, gates the one-line visible-commit dispatch (`dispatchApprovedVisibleCommit` in 0.0.47–0.0.49, renamed to `dispatchSynchronousVisibleCommit` in 0.0.50) in `app-browser-navigation-controller` on `!returnValue`; on ≥0.1.0, where that dispatch moved into a block body, wraps the bare dispatch call as `if (!returnValue) …`. Also rewrites the browser entry's relative shim import to use the pre-bundled alias (AST-based via ast-grep) |
| `cjsInterop` | Vite | Fixes CJS default export interop for packages like `bson-objectid` (via [vite-plugin-cjs-interop](https://github.com/cyco130/vite-plugin-cjs-interop)) |

## Known compatibility issues

These all work fine on Next.js — they exist because vinext reimplements
Next.js's framework layer on Vite.

| Issue | Owner | Our workaround |
| --- | --- | --- |
| Barrel exports missing `'use client'` directive | Payload | Auto-exclude affected packages from RSC optimizeDeps |
| RSC export transform drops exports after sourcemap comments | @vitejs/plugin-rsc | Post-transform newline insertion |
| `getHTMLDiffComponents` missing export in RSC build | @vitejs/plugin-rsc / Rolldown | Patch `@payloadcms/ui/dist/exports/rsc/index.js` at build start |
| `console.createTask` throws "not implemented" | workerd | Try/catch polyfill |
| `node:*` CJS requires bypass cloudflare plugin's resolveId filter | Rolldown / @cloudflare/vite-plugin | Filterless resolveId fallback routing to unenv polyfills |
| undici `detectRuntimeFeatureByExportedProperty` crashes on void | Rolldown | Try-catch wrapper around detection function |
| `import.meta.url` undefined in bundled workerd asset chunks | workerd | `?? "file:///"` fallback guard on `fileURLToPath` and `createRequire` |
| `ssr.external` only applies to "ssr" environment, not RSC | Vite | Use `build.rolldownOptions.external` via `configEnvironment` for both ssr/rsc |
| `file-type` / `drizzle-kit/api` unresolvable in workerd | pnpm + Vite | Stub modules for RSC |
| payload.config's `getPlatformProxy` fallback drags wrangler (and unresolvable `blake3-wasm`) into workerd bundles | Payload template / Rolldown | Stub `wrangler` in Vite environments; the fallback only runs under plain Node (payload CLI) |
| Browser entry imports shims via relative paths → optimizer reload + duplicate React | vinext | Rewrite import to aliased specifier; auto-include all `next/*` aliases in optimizeDeps |
| `render()` called before `returnValue` check → form state reset | vinext | AST transform to reorder render after returnValue |
| Components switch element types based on pathname/params → tree-destroying hydration mismatch | Payload | AST transform to force consistent element types |
| Non-serializable values (functions, RegExps) throw at RSC boundary | vinext | Patch serializer throws to `return undefined` (Next.js prod also throws; we deliberately drop instead) |
| Rolldown inlines Workers entry wrapper into bare function | Rolldown / @cloudflare/vite-plugin | `generateBundle` hook re-wraps default export in `{ fetch }` ([workers-sdk#10213](https://github.com/cloudflare/workers-sdk/issues/10213)) |
| CJS default export interop (e.g. `bson-objectid`) breaks named-import desugaring | Vite | `vite-plugin-cjs-interop` for the curated package list |

## Drift detection

The patches above match patterns in vinext's shipped `dist`. When vinext
restructures, a pattern can stop matching and the patch silently becomes a
no-op — the build still succeeds and unit tests (which use synthetic
fixtures) still pass. `test/patch-targets.test.ts` reads the *real* installed
vinext and asserts each patch target still exists; a failure there means
"re-verify this workaround against the new vinext".
