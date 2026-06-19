# vite-plugin-vinext-payload

Vite plugin for running [Payload CMS](https://payloadcms.com/) on Cloudflare Workers. Two modes:

- **`payloadPlugin()`** — full Payload (admin UI + REST/GraphQL) with [vinext](https://github.com/cloudflare/vinext), Cloudflare's Vite-based re-implementation of Next.js.
- **`payloadWorkerPlugin()`** — headless Payload exposing only its [Local API](https://payloadcms.com/docs/local-api/overview) via `WorkerEntrypoint` RPC, no admin UI. Pair with any Vite-based frontend framework (TanStack Start, SvelteKit, Remix, Nuxt) running as the parent worker.

> **Experimental.** Both vinext and this plugin are experimental.
>
> **Validated against:** Payload `3.82.1`–`3.85.1`, vinext `0.1.3` (optional — only needed for `payloadPlugin`), Vite `^8.0.16` (Rolldown), Node `>=24`.
>
> Peer dependency ranges are pinned to the validated stack — see [`docs/upstream-bugs.md`](docs/upstream-bugs.md) for known regressions.

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
- If a `wrangler.{jsonc,json,toml}` is present, also adds `cloudflare()` to `vite.config.ts` and `@cloudflare/vite-plugin` to `devDependencies`

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
		payloadPlugin(),
	],
});
```

`cloudflare:workers` is externalized automatically — no need to pass it via `ssrExternal`.

## Headless RPC Worker (no admin UI)

Run Payload as a separate Cloudflare auxiliary worker that exposes its Local API over `WorkerEntrypoint` RPC. The parent worker (TanStack Start, SvelteKit, Remix, Nuxt, etc.) talks to it via a service binding — no HTTP, no admin UI, no vinext.

```ts
// services/website/vite.config.ts (parent worker)
import { cloudflare } from "@cloudflare/vite-plugin";
import { payloadWorkerPlugin } from "vite-plugin-vinext-payload";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		// ...your framework plugin (tanstackStart, sveltekit, etc.)
		cloudflare({
			viteEnvironment: { name: "ssr" },
			auxiliaryWorkers: [
				{
					configPath: "../payload-cms/wrangler.jsonc",
					config: { main: "../payload-cms/src/rpc-only.ts" },
				},
			],
		}),
		// `env` is the auxiliary worker's vite env name (the cloudflare
		// plugin normalizes the worker's `name` from wrangler.jsonc:
		// "payload-cms" → "payload_cms"). Check `[vite] (...)` in the dev
		// log if you're unsure.
		...payloadWorkerPlugin({ env: "payload_cms" }),
	],
});
```

```ts
// services/payload-cms/src/rpc-only.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { getPayload } from "payload";
import config from "./payload.config";

export class CmsEntrypoint extends WorkerEntrypoint<Env> {
	async find(args: Parameters<Awaited<ReturnType<typeof getPayload>>["find"]>[0]) {
		const payload = await getPayload({ config });
		return payload.find(args);
	}
	// Expose whatever Local API surface you need.
}

// Required so the worker module satisfies wrangler's `fetch` shape, but
// the parent calls this worker over the service binding, not via HTTP.
export default {
	fetch: () => new Response("rpc-only", { status: 404 }),
};
```

Then in the parent's `wrangler.jsonc`, add a service binding pointing at `CmsEntrypoint` and call its methods from your loader / API route / server function. See Cloudflare's [WorkerEntrypoint docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) for the binding shape.

`payloadWorkerPlugin` composes a subset of the same sub-plugins as `payloadPlugin` (workerd polyfills, server externals, optimize-deps excludes, file-type / drizzle-kit/api stubs, CJS interop, CLI stubs) — everything needed for Payload's Local API to evaluate inside workerd, but none of the admin-UI / RSC / next-navigation fixes.

## Options

```ts
// Full Payload + vinext
payloadPlugin({
	// Additional packages to externalize from SSR bundling
	ssrExternal: ["some-native-package"],

	// Additional packages to exclude from optimizeDeps
	excludeFromOptimize: ["some-broken-package"],

	// Additional CJS packages needing default export interop
	cjsInteropDeps: ["some-cjs-dep"],
});

// Headless Payload-as-auxiliary-worker
payloadWorkerPlugin({
	// Required — the vite env name of the auxiliary worker (cloudflare
	// plugin normalizes the wrangler `name` to a JS identifier).
	env: "payload_cms",

	// Optional — same shape as payloadPlugin
	ssrExternal: ["..."],
	excludeFromOptimize: ["..."],
	cjsInteropDeps: ["..."],
});
```

## What It Does

`payloadPlugin()` composes these sub-plugins. They are not exported individually — splits exist purely for readability and maintenance:

| Plugin | Owner bug | What it does |
| --- | --- | --- |
| `payloadUseClientBarrel` | Payload | Auto-detects `@payloadcms/*` barrel files that re-export from `'use client'` modules and excludes them from RSC pre-bundling (pre-bundling strips the directive, breaking client references) |
| `payloadServerExternals` | Vite | Externalizes packages from both `ssr` and `rsc` environments. Only build tools and native addons are externalized (workerd can't resolve externals at runtime). Uses `configEnvironment` because `ssr.external` only applies to the `ssr` environment, and writes to `build.rolldownOptions.external` because `@cloudflare/vite-plugin` rejects `resolve.external` |
| `payloadWorkerdCompat` | workerd / Rolldown | Four module-resolution / bundle-time fixes needed before code can evaluate inside workerd: (1) `resolveId` fallback for `node:*` CJS requires that bypass `@cloudflare/vite-plugin`'s filtered hook, (2) try-catch wrapper for undici's `detectRuntimeFeatureByExportedProperty` which crashes due to Rolldown's CJS→ESM interop returning void, (3) `import.meta.url ?? "file:///"` guards for `fileURLToPath` / `createRequire` patterns that crash in bundled workerd asset chunks, (4) `console.createTask` polyfill — workerd defines the method but throws "not implemented", breaking React 19 dev mode's async stack traces. Injected via both Vite transform and optimizeDeps rolldown plugin to cover pre-bundled deps |
| `payloadWorkerdEntry` | Rolldown / @cloudflare/vite-plugin | `generateBundle` hook that re-wraps the RSC entry default export in `{ fetch }` when Rolldown inlines vinext's Workers handler wrapper into a bare function (regression of [workers-sdk#10213](https://github.com/cloudflare/workers-sdk/issues/10213) on Vite 8/Rolldown) |
| `payloadHtmlDiffExportFix` | @vitejs/plugin-rsc / Rolldown | Patches `@payloadcms/ui/dist/exports/rsc/index.js` at build start to stabilize `getHTMLDiffComponents` export when RSC/Rolldown reports it as missing in latest templates |
| `payloadOptimizeDeps` | vinext | Per-environment optimizeDeps: excludes problematic packages, force-includes CJS transitive deps for the client. Auto-discovers all `next/*` alias specifiers from the resolved config so the optimizer doesn't discover them at runtime (which causes a full page reload) |
| `payloadCjsTransform` | Vite | Fixes `this` → `globalThis` in UMD/CJS wrappers and wraps `module.exports` with ESM scaffolding (skips React/ReactDOM which Vite 8 handles natively) |
| `payloadCliStubs` | Payload | Stubs packages not needed at web runtime (`console-table-printer`, `json-schema-to-typescript`, `esbuild-register`, `ws`) |
| `payloadNavComponentFix` | Payload | Patches `DefaultNavClient` and `DocumentTabLink` to not switch element types (`<a>` vs `<div>`) based on `usePathname()`/`useParams()` — prevents React 19 tree-destroying hydration mismatches (AST-based via ast-grep) |
| `payloadNextNavigationFix` | vinext | Patches vinext's `next/navigation` shim on disk so `usePathname`/`useParams`/`useSearchParams` use client snapshots during hydration instead of the server context (which is `null` on the client) |
| `payloadRscExportFix` | @vitejs/plugin-rsc | Fixes `@vitejs/plugin-rsc`'s CSS export transform dropping exports after sourcemap comments |
| `payloadRscRuntime` | vinext / workerd / pnpm | RSC environment patches: stubs `file-type` and `drizzle-kit/api`, and patches the RSC serializer to silently drop non-serializable values (functions, RegExps) at the server/client boundary (matching Next.js prod behavior) |
| `payloadServerActionFix` | vinext | Prevents data-returning server actions (like `getFormState`) from triggering a re-render that resets Payload's form state. Shape depends on vinext version: on ≤0.0.46, moves `getReactRoot().render()` after the `returnValue` check in `app-browser-entry`; on 0.0.47–0.0.55, gates the one-line visible-commit dispatch (`dispatchApprovedVisibleCommit` in 0.0.47–0.0.49, renamed to `dispatchSynchronousVisibleCommit` in 0.0.50) in `app-browser-navigation-controller` on `!returnValue`; on ≥0.1.0, where that dispatch moved into a block body, wraps the bare dispatch call as `if (!returnValue) …`. Also rewrites the browser entry's relative shim import to use the pre-bundled alias (AST-based via ast-grep) |
| `cjsInterop` | Vite | Fixes CJS default export interop for packages like `bson-objectid` (via [vite-plugin-cjs-interop](https://github.com/nicolo-ribaudo/vite-plugin-cjs-interop)) |

## Requirements

- Node.js `>=24`
- Vite `^8.0.0`
- Payload CMS `^3.82.0`
- vinext `0.1.3` (exact — vinext is pre-1.0; every patch can break things). Optional — only needed when using `payloadPlugin()`. Not required for `payloadWorkerPlugin()`.

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
| Rolldown inlines Workers entry wrapper into bare function | Rolldown / @cloudflare/vite-plugin | `generateBundle` hook re-wraps default export in `{ fetch }` ([workers-sdk#10213](https://github.com/cloudflare/workers-sdk/issues/10213)) |
| CJS default export interop (e.g. `bson-objectid`) breaks named-import desugaring | Vite | `vite-plugin-cjs-interop` for the curated package list |

## License

MIT
