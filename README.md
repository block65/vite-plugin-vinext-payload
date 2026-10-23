# vite-plugin-vinext-payload

Runs [Payload CMS](https://payloadcms.com/) under
[vinext](https://github.com/cloudflare/vinext), Cloudflare's Vite-based
reimplementation of Next.js, including on Cloudflare Workers.

Payload 3 runs as a Next.js application; vinext reimplements Next.js's
framework layer on Vite. This plugin closes the differences between the two
(RSC pre-bundling, the workerd runtime surface, Rolldown output shapes, CJS
interop) so the admin UI, the REST and GraphQL APIs, server actions and uploads
run without modification.

## Installation

```sh
npm install -D vite-plugin-vinext-payload
```

## Configuration

### Node

```ts
// vite.config.ts
import { defineConfig } from "vite";
import vinext from "vinext";
import vinextPayload from "vite-plugin-vinext-payload";

export default defineConfig({
	plugins: [vinext(), vinextPayload()],
});
```

Then `npm run dev`.

### Cloudflare Workers

Add the Cloudflare plugin and name the RSC environment:

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

`cloudflare:workers` is externalized by the plugin and does not need listing in
`ssrExternal`. The order above and the order `init` writes (`vinext()`,
`vinextPayload()`, `cloudflare()`) each have an e2e suite covering them.

For D1-backed projects, see the
**[Cloudflare D1 guide](docs/cloudflare-d1.md)**.

### Headless RPC worker

The package exports two plugin factories:

- **`vinextPayload()`** — the full CMS: admin UI plus the REST and GraphQL
  APIs, running under vinext. This is what the sections above configure.
- **`vinextPayloadWorker()`** — Payload's
  [Local API](https://payloadcms.com/docs/local-api/overview) only, exposed
  over `WorkerEntrypoint` RPC as a Cloudflare auxiliary worker. No admin UI, no
  HTTP, no vinext. The parent worker holds the frontend framework and reaches
  Payload through a service binding, so the frontend can be anything Vite
  builds.

```ts
// services/website/vite.config.ts (parent worker)
import { cloudflare } from "@cloudflare/vite-plugin";
import { vinextPayloadWorker } from "vite-plugin-vinext-payload";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		// ...the parent framework's Vite plugin
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

The parent's `wrangler.jsonc` then needs a service binding pointing at
`CmsEntrypoint`, whose methods the parent calls from a loader, API route or
server function. Cloudflare's
[WorkerEntrypoint docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)
describe the binding shape.

`vinextPayloadWorker()` composes a subset of the same sub-plugins as
`vinextPayload()`: server externals, workerd compatibility, optimizeDeps
configuration, `file-type` resolution, the `drizzle-kit/api` stub, the CJS transform
and interop, and the CLI stubs. Everything Payload's Local API needs to
evaluate inside workerd, and none of the admin-UI or RSC fixes.

## Migrating a Next.js project

`init` converts an existing Payload project from Next.js:

```sh
npm install -D vinext vite             # Install vinext
npx vinext init                        # Convert Next.js → vinext
npm install -D vite-plugin-vinext-payload
npx vite-plugin-vinext-payload init    # Apply Payload-specific fixes
npm run dev
```

`init` is idempotent, so repeated runs are safe; `--dry-run` prints the changes
without writing them. It:

- Adds `vinextPayload()` to `vite.config.ts`
- Extracts the inline server function from `layout.tsx` into a separate
  `'use server'` module, which Vite's RSC transform requires
- Adds `normalizeParams` to the admin page
- Adds `cloudflare()` to `vite.config.ts` and `@cloudflare/vite-plugin` to
  `devDependencies` when a `wrangler.{jsonc,json,toml}` is present

`vinext init` runs the detected package manager's install internally (npm,
pnpm, yarn or bun). Peer dependency conflicts with `@vitejs/plugin-react` are
common; installing with `npm install -D vinext vite --legacy-peer-deps` before
`npx vinext init` avoids them.

## Options

| Option                | Type       | Description                                                                                                                                                                               |
| --------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`                 | `string`   | **`vinextPayloadWorker()` only, required.** Vite environment name of the auxiliary worker. Must match the worker's `name` in `auxiliaryWorkers`, or the top-level `viteEnvironment.name`. |
| `ssrExternal`         | `string[]` | Additional packages to externalize from server (SSR + RSC) bundling. Merged with the built-in list: esbuild, wrangler, miniflare, sharp.                                                  |
| `excludeFromOptimize` | `string[]` | Additional packages to exclude from `optimizeDeps`.                                                                                                                                       |
| `cjsInteropDeps`      | `string[]` | Additional CommonJS packages needing default-export interop.                                                                                                                              |

## Requirements

- Node.js `>=24`
- Vite `^8.0.0`
- Payload CMS `^3.82.0`
- vinext `1.0.0-beta.8`, exact. vinext is pre-release and every bump moves
  internals this plugin patches. Required by `vinextPayload()` only;
  `vinextPayloadWorker()` runs without it.

## Status

Both vinext and this plugin are experimental.

Validated against Payload `3.88.0`, vinext `1.0.0-beta.8`, Vite `8.2.2`
(Rolldown) and Node `>=24`, the versions the e2e suites pin in
`test/helpers.ts`. The peer dependency ranges match that stack. Known upstream
regressions are listed in [`docs/upstream-bugs.md`](docs/upstream-bugs.md).

## Internals

The plugin rewrites other packages' code at build time. Each rewrite is
declared as data (`PATCH_MANIFEST` in [`src/main.ts`](src/main.ts)) and
tabulated in [`docs/internals.md`](docs/internals.md), which a unit test keeps
in sync with the declarations. None of it is needed to use the plugin.

## License

MIT
