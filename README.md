# vite-plugin-vinext-payload

Vite plugin for running [Payload CMS](https://payloadcms.com/) with [vinext](https://github.com/cloudflare/vinext) (Cloudflare's Vite-based re-implementation of Next.js).

> **Experimental.** Both vinext and this plugin are experimental. Latest validation targeted Payload 3.82.1 templates with vinext 0.0.41 and Vite 8 (Rolldown); see known RSC build regression notes in [`docs/upstream-bugs.md`](docs/upstream-bugs.md).

## Migrating from Next.js

If you have an existing Payload CMS project on Next.js:

```sh
npm install -D vinext vite             # Install vinext
npx vinext init                        # Convert Next.js → vinext
npm install -D vite-plugin-vinext-payload
npx vite-plugin-vinext-payload init    # Apply Payload-specific fixes
npm run dev
```

> **Note:** `vinext init` runs `npm install` internally. If you hit peer dependency conflicts (common with `@vitejs/plugin-react`), run `npm install -D vinext vite --legacy-peer-deps` before `npx vinext init`.

The plugin's `init` command is idempotent — safe to run multiple times. It:

- Adds `payloadPlugin()` to your `vite.config.ts`
- Extracts the inline server function from `layout.tsx` into a separate `'use server'` module (required for Vite's RSC transform)
- Adds `normalizeParams` to the admin page

Use `--dry-run` to preview changes without writing files.

For Cloudflare D1 projects, see **[Cloudflare D1 guide](docs/cloudflare-d1.md)** for additional configuration.

## Quick Start

If you've already run `init`, or are setting up manually:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { payloadPlugin } from "vite-plugin-vinext-payload";

export default defineConfig({
	plugins: [vinext(), payloadPlugin()],
});
```

For Cloudflare Workers with RSC:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import { payloadPlugin } from "vite-plugin-vinext-payload";

export default defineConfig({
	plugins: [
		cloudflare({
			viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
		}),
		vinext(),
		payloadPlugin({
			ssrExternal: ["cloudflare:workers"],
		}),
	],
});
```

## Options

```ts
payloadPlugin({
	// Additional packages to externalize from SSR bundling
	ssrExternal: ["some-native-package"],

	// Additional packages to exclude from optimizeDeps
	excludeFromOptimize: ["some-broken-package"],

	// Additional CJS packages needing default export interop
	cjsInteropDeps: ["some-cjs-dep"],
});
```

## What It Does

`payloadPlugin()` composes these sub-plugins:

| Plugin | Owner bug | What it does |
| --- | --- | --- |
| `payloadUseClientBarrel` | Payload | Auto-detects `@payloadcms/*` barrel files that re-export from `'use client'` modules and excludes them from RSC pre-bundling (pre-bundling strips the directive, breaking client references) |
| `payloadConfigAlias` | Vite | Configures SSR/RSC externals via `build.rolldownOptions.external` — only build tools and native addons are externalized (workerd can't resolve externals at runtime). Uses `configEnvironment` to apply to both `ssr` and `rsc` environments (Vite's `ssr.external` only applies to the `ssr` environment) |
| `payloadNodeBuiltinFix` | workerd / Rolldown | Fixes four Workers runtime compatibility issues: (1) resolveId fallback for `node:*` CJS requires that bypass @cloudflare/vite-plugin's filtered hook, (2) try-catch wrapper for undici's `detectRuntimeFeatureByExportedProperty` which crashes due to Rolldown's CJS→ESM interop returning void, (3) `import.meta.url ?? "file:///"` guards for `fileURLToPath` and `createRequire` patterns that crash when bundled in workerd asset chunks, (4) `generateBundle` hook that re-wraps the entry export in `{ fetch }` when Rolldown inlines vinext's Workers handler wrapper into a bare function (regression of [workers-sdk#10213](https://github.com/cloudflare/workers-sdk/issues/10213) on Vite 8/Rolldown) |
| `payloadHtmlDiffExportFix` | @vitejs/plugin-rsc / Rolldown | Patches `@payloadcms/ui/dist/exports/rsc/index.js` at build start to stabilize `getHTMLDiffComponents` export when RSC/Rolldown reports it as missing in latest templates |
| `payloadOptimizeDeps` | vinext | Per-environment optimizeDeps: excludes problematic packages, force-includes CJS transitive deps for the client. Auto-discovers all `next/*` alias specifiers from the resolved config so the optimizer doesn't discover them at runtime (which causes a full page reload) |
| `payloadCjsTransform` | Vite | Fixes `this` → `globalThis` in UMD/CJS wrappers and wraps `module.exports` with ESM scaffolding (skips React/ReactDOM which Vite 8 handles natively) |
| `payloadCliStubs` | Payload | Stubs packages not needed at web runtime (`console-table-printer`, `json-schema-to-typescript`, `esbuild-register`, `ws`) |
| `payloadNavHydrationFix` | Payload | Patches `DefaultNavClient` and `DocumentTabLink` to not switch element types (`<a>` vs `<div>`) based on `usePathname()`/`useParams()` — prevents React 19 tree-destroying hydration mismatches (AST-based via ast-grep) |
| `payloadNavigationHydrationFix` | vinext | Patches vinext's `next/navigation` shim on disk so `usePathname`/`useParams`/`useSearchParams` use client snapshots during hydration instead of the server context (which is `null` on the client) |
| `payloadRedirectFix` | vinext | Catches `NEXT_REDIRECT` errors that leak through the RSC stream during async rendering and converts them to client-side `location.replace()` redirects |
| `payloadRscExportFix` | @vitejs/plugin-rsc | Fixes `@vitejs/plugin-rsc`'s CSS export transform dropping exports after sourcemap comments |
| `payloadRscStubs` | vinext / workerd / pnpm | Stubs `file-type` and `drizzle-kit/api` for RSC/workerd, polyfills workerd's broken `console.createTask`, patches RSC serializer to silently drop non-serializable values (functions, RegExps) at the server/client boundary (matching Next.js prod behavior) |
| `payloadServerActionFix` | vinext | Moves `getReactRoot().render()` after the `returnValue` check in vinext's browser entry so data-returning server actions (like `getFormState`) don't trigger a re-render that resets Payload's form state. Also rewrites the browser entry's relative shim import to use the pre-bundled alias (AST-based via ast-grep) |
| `cjsInterop` | Vite | Fixes CJS default export interop for packages like `bson-objectid` (via [vite-plugin-cjs-interop](https://github.com/nicolo-ribaudo/vite-plugin-cjs-interop)) |

## A La Carte

Import individual plugins if you need fine-grained control:

```ts
import {
	payloadUseClientBarrel,
	payloadConfigAlias,
	payloadNodeBuiltinFix,
	payloadHtmlDiffExportFix,
	payloadOptimizeDeps,
	payloadCjsTransform,
	payloadCliStubs,
	payloadNavHydrationFix,
	payloadNavigationHydrationFix,
	payloadRedirectFix,
	payloadRscExportFix,
	payloadRscStubs,
	payloadServerActionFix,
} from "vite-plugin-vinext-payload";
```

## Requirements

- Node.js >= 24
- Vite 8 (may work on 6/7 but untested)
- vinext 0.0.37+
- Payload CMS 3.x

## Known Compatibility Issues

These all work fine on Next.js — they exist because vinext reimplements Next.js's framework layer on Vite. See [`docs/upstream-bugs.md`](docs/upstream-bugs.md) for details on what Next.js does differently.

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
| Navigation shim `getServerSnapshot` returns wrong values during hydration | vinext | Patch on disk to use client snapshots |
| Browser entry imports shims via relative paths → optimizer reload + duplicate React | vinext | Rewrite import to aliased specifier; auto-include all `next/*` aliases in optimizeDeps |
| `render()` called before `returnValue` check → form state reset | vinext | AST transform to reorder render after returnValue |
| Components switch element types based on pathname/params → tree-destroying hydration mismatch | Payload | AST transform to force consistent element types |
| Non-serializable values (functions, RegExps) not silently dropped at RSC boundary | vinext | Patch serializer throws to `return undefined` |
| `NEXT_REDIRECT` errors leak through RSC stream during async rendering | vinext | Client-side redirect interception |
| Rolldown inlines Workers entry wrapper into bare function | Rolldown / @cloudflare/vite-plugin | `generateBundle` hook re-wraps default export in `{ fetch }` ([workers-sdk#10213](https://github.com/cloudflare/workers-sdk/issues/10213)) |

## License

MIT
