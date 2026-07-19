# vite-plugin-vinext-payload

A Vite plugin that makes [Payload CMS](https://payloadcms.com/) run under
[vinext](https://github.com/cloudflare/vinext), including on Cloudflare Workers.

## Quick Start

```sh
npm install -D vite-plugin-vinext-payload
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import vinext from "vinext";
import vinextPayload from "vite-plugin-vinext-payload";

export default defineConfig({
	plugins: [vinext(), vinextPayload()],
});
```

```sh
npm run dev
```

That's it. For Cloudflare Workers with RSC, add the Cloudflare plugin:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import vinextPayload from "vite-plugin-vinext-payload";

export default defineConfig({
	plugins: [
		cloudflare({
			viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
		}),
		vinext(),
		vinextPayload(),
	],
});
```

`cloudflare:workers` is externalized automatically — no need to pass it via `ssrExternal`.

For Cloudflare D1 projects, see the **[Cloudflare D1 guide](docs/cloudflare-d1.md)**.

## Migrating from Next.js

Already have a Payload CMS project on Next.js? The `init` command converts it:

```sh
npm install -D vinext vite             # Install vinext
npx vinext init                        # Convert Next.js → vinext
npm install -D vite-plugin-vinext-payload
npx vite-plugin-vinext-payload init    # Apply Payload-specific fixes
npm run dev
```

`init` is idempotent — safe to run multiple times. Use `--dry-run` to preview changes. It:

- Adds `vinextPayload()` to the project's `vite.config.ts`
- Extracts the inline server function from `layout.tsx` into a separate `'use server'` module (required for Vite's RSC transform)
- Adds `normalizeParams` to the admin page
- If a `wrangler.{jsonc,json,toml}` is present, also adds `cloudflare()` to `vite.config.ts` and `@cloudflare/vite-plugin` to `devDependencies`

> **Note:** `vinext init` runs the project's package manager install internally (npm/pnpm/yarn/bun, detected from the project). Peer dependency conflicts are common with `@vitejs/plugin-react`; installing with `npm install -D vinext vite --legacy-peer-deps` before `npx vinext init` avoids them.

## Two Modes

- **`vinextPayload()`** — full Payload (admin UI + REST/GraphQL) with [vinext](https://github.com/cloudflare/vinext), Cloudflare's Vite-based re-implementation of Next.js. This is what the Quick Start above uses.
- **`vinextPayloadWorker()`** — headless Payload exposing only its [Local API](https://payloadcms.com/docs/local-api/overview) via `WorkerEntrypoint` RPC, no admin UI. Pair with any Vite-based frontend framework (TanStack Start, SvelteKit, Remix, Nuxt) running as the parent worker.

### Headless RPC Worker (no admin UI)

Run Payload as a separate Cloudflare auxiliary worker that exposes its Local API over `WorkerEntrypoint` RPC. The parent worker talks to it via a service binding — no HTTP, no admin UI, no vinext.

```ts
// services/website/vite.config.ts (parent worker)
import { cloudflare } from "@cloudflare/vite-plugin";
import { vinextPayloadWorker } from "vite-plugin-vinext-payload";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		// ...the framework plugin (tanstackStart, sveltekit, etc.)
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
		// "payload-cms" → "payload_cms"). The `[vite] (...)` prefix in the
		// dev log confirms it.
		...vinextPayloadWorker({ env: "payload_cms" }),
	],
});
```

```ts
// services/payload-cms/src/rpc-only.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { getPayload } from "payload";
import config from "./payload.config";

export class CmsEntrypoint extends WorkerEntrypoint<Env> {
	async find(
		args: Parameters<Awaited<ReturnType<typeof getPayload>>["find"]>[0],
	) {
		const payload = await getPayload({ config });
		return payload.find(args);
	}
	// Expose whatever Local API surface the parent worker needs.
}

// Required so the worker module satisfies wrangler's `fetch` shape, but
// the parent calls this worker over the service binding, not via HTTP.
export default {
	fetch: () => new Response("rpc-only", { status: 404 }),
};
```

Then in the parent's `wrangler.jsonc`, add a service binding pointing at `CmsEntrypoint` and call its methods from the parent's loader / API route / server function. See Cloudflare's [WorkerEntrypoint docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) for the binding shape.

`vinextPayloadWorker` composes a subset of the same sub-plugins as `vinextPayload` (workerd polyfills, server externals, optimize-deps excludes, file-type / drizzle-kit/api stubs, CJS interop, CLI stubs) — everything needed for Payload's Local API to evaluate inside workerd, but none of the admin-UI / RSC fixes.

## Options

```ts
// Full Payload + vinext
vinextPayload({
	// Additional packages to externalize from SSR bundling
	ssrExternal: ["some-native-package"],

	// Additional packages to exclude from optimizeDeps
	excludeFromOptimize: ["some-broken-package"],

	// Additional CJS packages needing default export interop
	cjsInteropDeps: ["some-cjs-dep"],
});

// Headless Payload-as-auxiliary-worker
vinextPayloadWorker({
	// Required — the vite env name of the auxiliary worker (cloudflare
	// plugin normalizes the wrangler `name` to a JS identifier).
	env: "payload_cms",

	// Optional — same shape as vinextPayload
	ssrExternal: ["..."],
	excludeFromOptimize: ["..."],
	cjsInteropDeps: ["..."],
});
```

## Requirements

- Node.js `>=24`
- Vite `^8.0.0`
- Payload CMS `^3.82.0`
- vinext `1.0.0-beta.2` (exact — vinext is still pre-release; every bump can break things). Optional — only needed when using `vinextPayload()`. Not required for `vinextPayloadWorker()`.

> **Experimental.** Both vinext and this plugin are experimental.
>
> **Validated against:** Payload `3.86.0`, vinext `1.0.0-beta.2`, Vite `8.1.5` (Rolldown), Node `>=24` — the versions the e2e suites pin (`test/helpers.ts`). Peer dependency ranges are pinned to the validated stack — see [`docs/upstream-bugs.md`](docs/upstream-bugs.md) for known regressions.

## What It Does

Payload CMS targets Next.js; vinext reimplements Next.js's framework layer on
Vite and Cloudflare Workers. The gap between the two — RSC pre-bundling,
workerd's runtime surface, Rolldown's output shapes, CJS interop — is what
this plugin closes. It applies a set of workarounds so that the admin UI,
REST/GraphQL API, server actions, and uploads work without hand-patching.
The individual fixes are not needed to use the plugin; they are listed in
[`docs/internals.md`](docs/internals.md) and the underlying bugs in
[`docs/upstream-bugs.md`](docs/upstream-bugs.md).

### Build-time patches

This plugin rewrites other packages' code at build time. Every such rewrite
is declared as data (`PATCH_MANIFEST` in [`src/main.ts`](src/main.ts)); the
plugin announces one summary line per build, lists each patch under
`DEBUG=vinext-payload`, and at the end of a production build warns for any
declared patch that no longer found its target — the defect it works around
may then be back. Transform patches with an id filter are gated through
their declaration, so a pattern cannot rewrite code outside what this table
discloses.

<!-- patch-table:begin — generated from PATCH_MANIFEST by scripts/patch-table.ts; edit the src/ declarations, then `pnpm run docs:patches` -->

| Patch                           | Kind       | Rewrites                                                                                                                                                                                                                                                     | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Remove when                                                                                                                 |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `use-client-barrel`             | config     | @payloadcms/* — subpath barrels re-exporting 'use client' modules, excluded from rsc optimizeDeps                                                                                                                                                            | pre-bundling merges barrels with their re-exported modules and strips 'use client', so plugin-rsc executes client components on the server                                                                                                                                                                                                                                                                                                                   | @vitejs/plugin-rsc follows re-export chains to detect 'use client' directives                                               |
| `server-externals`              | config     | esbuild, wrangler, miniflare, sharp — externalized from server bundles<br>cloudflare:workers — externalized everywhere                                                                                                                                       | build/deploy tools and native addons cannot be bundled, and the client environment must not try to bundle the workerd-only cloudflare:workers specifier                                                                                                                                                                                                                                                                                                      | never — build tools and native addons stay external                                                                         |
| `workerd-console-createtask`    | transform  | react — any module calling console.createTask (dev mode)                                                                                                                                                                                                     | workerd's node:console defines console.createTask but throws 'not implemented' when called; React 19 dev mode calls it for async stack traces                                                                                                                                                                                                                                                                                                                | workerd makes console.createTask a no-op instead of throwing                                                                |
| `workerd-undici-feature-detect` | transform  | undici — runtime-features detection                                                                                                                                                                                                                          | Rolldown converts undici's lazy require('node:*') into a void-returning ESM initializer, so its feature probe reads a property off undefined and throws instead of returning false                                                                                                                                                                                                                                                                           | Rolldown preserves require() semantics for externalized node builtins, or undici guards its probe                           |
| `workerd-import-meta-url-guard` | transform  | any server-environment module calling fileURLToPath(import.meta.url) or createRequire(import.meta.url)                                                                                                                                                       | bundled asset modules in workerd can see import.meta.url as undefined, crashing module init                                                                                                                                                                                                                                                                                                                                                                  | workerd provides import.meta.url for bundled modules                                                                        |
| `workerd-node-builtin-shims`    | stub       | node:* imports in workerd environments → unenv/node/*                                                                                                                                                                                                        | workerd does not provide Node builtins; unenv's shims keep transitive imports loadable                                                                                                                                                                                                                                                                                                                                                                       | workerd's node compatibility covers the builtins Payload pulls in                                                           |
| `workerd-entry`                 | transform  | vinext — the built rsc entry chunk's default export                                                                                                                                                                                                          | on Vite 8/Rolldown the { fetch } wrapper of vinext's app-router-entry can be inlined to a bare function, and a Worker whose default export has no fetch method fails to start<br>Currently defensive: expected to rewrite nothing.<br>https://github.com/cloudflare/workers-sdk/issues/10213<br>https://github.com/cloudflare/workers-sdk/pull/10544<br>https://github.com/rolldown/rolldown/issues/3500<br>https://github.com/rolldown/rolldown/issues/6449 | Rolldown enforces preserveEntrySignatures: 'strict' for this inlining case                                                  |
| `html-diff-export-fix`          | file-write | @payloadcms/ui — dist/exports/rsc/index.js, rewritten on disk                                                                                                                                                                                                | on vinext/Rolldown builds the HTMLDiff re-export resolves to a module missing getHTMLDiffComponents, so the version-diff view crashes; the export is replaced with a local implementation                                                                                                                                                                                                                                                                    | @payloadcms/ui's rsc export of getHTMLDiffComponents resolves under Rolldown                                                |
| `optimize-deps`                 | config     | file-type, blake3-wasm, wrangler, @payloadcms/next — excluded from optimizeDeps in every environment<br>payload > ajv, payload > bson-objectid, react/compiler-runtime, @payloadcms/ui and discovered next/* aliases — force-included in client optimizeDeps | these packages break during esbuild/Rolldown pre-bundling for structural reasons webpack handles natively, and excluded parents lose CJS auto-discovery for their children; per-entry notes live in payload-packages.ts<br>https://github.com/cloudflare/vinext/issues/538                                                                                                                                                                                   | per-entry conditions in payload-packages.ts — the lists shrink entry by entry                                               |
| `cjs-transform`                 | transform  | any node_modules CJS/UMD file except react, react-dom, react-server-dom-webpack and scheduler                                                                                                                                                                | files served raw via /@fs/ break in the browser (module.exports) and in Vite's strict-ESM module runner, where module-scope `this` is undefined for UMD wrappers and TS CJS helpers                                                                                                                                                                                                                                                                          | Vite converts CJS to ESM for files served outside optimizeDeps pre-bundling                                                 |
| `cli-stubs`                     | stub       | console-table-printer, json-schema-to-typescript, esbuild-register, ws, wrangler, pnpapi → no-op stubs                                                                                                                                                       | these are reached only by Payload CLI commands or Next-specific code paths, and bundling them drags broken dependencies into the graph (wrangler's CLI pulls in blake3-wasm, which Rolldown cannot resolve); ws and wrangler throw on use so genuine Node-side calls stay loud                                                                                                                                                                               | payload lazy-loads its CLI-only dependencies behind dynamic imports                                                         |
| `nav-component-fix`             | transform  | @payloadcms/next — Nav/index.client.js (DefaultNavClient)<br>@payloadcms/next — DocumentHeader Tabs TabLink.js (DocumentTabLink)                                                                                                                             | vinext's usePathname()/useParams() differ between SSR and client hydration, so these components render different element types and React 19 discards the server tree, dropping form state                                                                                                                                                                                                                                                                    | vinext's navigation hooks use React context like Next.js, or Payload removes the conditional element type rendering         |
| `rsc-export-fix`                | transform  | @vitejs/plugin-rsc — output of its CSS export transform, rsc environment only                                                                                                                                                                                | plugin-rsc relocates export statements to end-of-file with MagicString; when the source ends in a sourcemap comment without a trailing newline the export lands inside the comment and Rolldown cannot see it<br>https://github.com/vitejs/vite-plugin-react (plugin-rsc)                                                                                                                                                                                    | plugin-rsc's transformWrapExport emits a newline before relocated exports                                                   |
| `rsc-runtime-stubs`             | stub       | file-type → no-op stub (server environments)<br>drizzle-kit/api → no-op stub, including inlined createRequire() calls                                                                                                                                        | both are transitively imported but never invoked during RSC rendering, and leave bare imports the workerd module runner cannot resolve; per-entry notes live in payload-packages.ts (RSC_STUBS)                                                                                                                                                                                                                                                              | workerd supports the Node APIs they need, or payload lazy-loads them                                                        |
| `rsc-serializer-throws`         | transform  | react-server-dom-webpack — 'Client Component' serializer throws                                                                                                                                                                                              | the RSC serializer throws for values that cannot cross the server/client boundary (access functions, hooks, RegExps in Payload field configs); Next.js silently drops them in production, vinext does not, so every Payload page would fail                                                                                                                                                                                                                  | vinext's RSC pipeline tolerates non-serializable config values the way Next.js does                                         |
| `server-action-fix`             | transform  | vinext — server/app-browser-entry.js<br>vinext — server/app-browser-navigation-controller.js                                                                                                                                                                 | vinext applies the RSC tree of a data-returning server action before returning its data, resetting Payload form state and looping getFormState; its browser entry also imports the navigation shim by relative path, bypassing the pre-bundled next/navigation alias and forcing a runtime re-optimize                                                                                                                                                       | vinext uses the aliased next/navigation in its browser entry and skips the visible commit for data-returning server actions |
| `cjs-default-interop`           | transform  | pluralize, bson-objectid — via vite-plugin-cjs-interop                                                                                                                                                                                                       | their CJS default exports arrive as { default: fn } without interop wrapping, so calls like pluralize('item') break at runtime                                                                                                                                                                                                                                                                                                                               | these packages ship native ESM                                                                                              |

<!-- patch-table:end -->

## License

MIT
