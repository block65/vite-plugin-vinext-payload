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
import { payloadPlugin } from "vite-plugin-vinext-payload";

export default defineConfig({
	plugins: [vinext(), payloadPlugin()],
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

- Adds `payloadPlugin()` to the project's `vite.config.ts`
- Extracts the inline server function from `layout.tsx` into a separate `'use server'` module (required for Vite's RSC transform)
- Adds `normalizeParams` to the admin page
- If a `wrangler.{jsonc,json,toml}` is present, also adds `cloudflare()` to `vite.config.ts` and `@cloudflare/vite-plugin` to `devDependencies`

> **Note:** `vinext init` runs the project's package manager install internally (npm/pnpm/yarn/bun, detected from the project). Peer dependency conflicts are common with `@vitejs/plugin-react`; installing with `npm install -D vinext vite --legacy-peer-deps` before `npx vinext init` avoids them.

## Two Modes

- **`payloadPlugin()`** — full Payload (admin UI + REST/GraphQL) with [vinext](https://github.com/cloudflare/vinext), Cloudflare's Vite-based re-implementation of Next.js. This is what the Quick Start above uses.
- **`payloadWorkerPlugin()`** — headless Payload exposing only its [Local API](https://payloadcms.com/docs/local-api/overview) via `WorkerEntrypoint` RPC, no admin UI. Pair with any Vite-based frontend framework (TanStack Start, SvelteKit, Remix, Nuxt) running as the parent worker.

### Headless RPC Worker (no admin UI)

Run Payload as a separate Cloudflare auxiliary worker that exposes its Local API over `WorkerEntrypoint` RPC. The parent worker talks to it via a service binding — no HTTP, no admin UI, no vinext.

```ts
// services/website/vite.config.ts (parent worker)
import { cloudflare } from "@cloudflare/vite-plugin";
import { payloadWorkerPlugin } from "vite-plugin-vinext-payload";
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

`payloadWorkerPlugin` composes a subset of the same sub-plugins as `payloadPlugin` (workerd polyfills, server externals, optimize-deps excludes, file-type / drizzle-kit/api stubs, CJS interop, CLI stubs) — everything needed for Payload's Local API to evaluate inside workerd, but none of the admin-UI / RSC fixes.

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

## Requirements

- Node.js `>=24`
- Vite `^8.0.0`
- Payload CMS `^3.82.0`
- vinext `1.0.0-beta.2` (exact — vinext is still pre-release; every bump can break things). Optional — only needed when using `payloadPlugin()`. Not required for `payloadWorkerPlugin()`.

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

## License

MIT
