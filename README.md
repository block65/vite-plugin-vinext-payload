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
import vinext from "vinext";
import { defineConfig } from "vite";
import vinextPayload from "vite-plugin-vinext-payload";

export default defineConfig({
	plugins: [vinext(), vinextPayload()],
});
```

Then `npm run dev`.

### Cloudflare Workers

Start from what `vinext init --platform=cloudflare` writes
(`@cloudflare/vite-plugin` v2 and a `cloudflare.config.ts`), and add
`vinextPayload()` after `vinext()`:

```ts
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import vinextPayload from "vite-plugin-vinext-payload";

export default defineConfig({
	plugins: [
		vinext(),
		vinextPayload(),
		cloudflare({
			viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
		}),
	],
});
```

Keep any options init passed to `vinext()`, such as its CDN cache adapter.
`cloudflare:workers` is externalized by the plugin and does not need listing in
`ssrExternal`.

Declare `PAYLOAD_SECRET` in `cloudflare.config.ts` with `bindings.secret()`:
the v2 plugin passes only declared secrets to the Worker. Bindings, schema
setup and the template's OpenNext leftovers are covered in the
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
import { defineConfig } from "vite";
import { vinextPayloadWorker } from "vite-plugin-vinext-payload";

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
configuration, `file-type` resolution, the `drizzle-kit/api` stub, and the CJS
transform. Everything Payload's Local API needs to
evaluate inside workerd, and none of the admin-UI or RSC fixes.

## `init` (deprecated)

`npx vite-plugin-vinext-payload init` is deprecated and will be removed in a
later release. Run `vinext init`, then add `vinextPayload()` as shown above.

## Options

| Option                | Type       | Description                                                                                                                                                                               |
| --------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`                 | `string`   | **`vinextPayloadWorker()` only, required.** Vite environment name of the auxiliary worker. Must match the worker's `name` in `auxiliaryWorkers`, or the top-level `viteEnvironment.name`. |
| `ssrExternal`         | `string[]` | Additional packages to externalize from server (SSR + RSC) bundling. Merged with the built-in list: esbuild, wrangler, miniflare, sharp.                                                  |
| `excludeFromOptimize` | `string[]` | Additional packages to exclude from `optimizeDeps`.                                                                                                                                       |

## Requirements

- Node.js `>=24`
- Vite `^8.0.0`
- Payload CMS `^3.82.0`
- vinext `1.2.1`, exact. Every vinext release can move the internals this
  plugin patches. Required by `vinextPayload()` only; `vinextPayloadWorker()`
  runs without it.

## Status

Both vinext and this plugin are experimental.

Validated against Payload `3.91.0`, vinext `1.2.1`, Vite `8.3.4` (Rolldown),
`@cloudflare/vite-plugin` v2 and Node `>=24`, the versions the e2e suites pin in
`test/helpers.ts`. The peer dependency ranges match that stack. Known upstream
regressions are listed in [`docs/upstream-bugs.md`](docs/upstream-bugs.md).

## Internals

The plugin rewrites other packages' code at build time. Each rewrite is
declared as data (`PATCH_MANIFEST` in [`src/main.ts`](src/main.ts)) and
tabulated in [`docs/internals.md`](docs/internals.md), which a unit test keeps
in sync with the declarations. None of it is needed to use the plugin.

## License

MIT
