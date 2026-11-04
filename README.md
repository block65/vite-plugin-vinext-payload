# vite-plugin-vinext-payload

Runs [Payload CMS](https://payloadcms.com/) under
[vinext](https://github.com/cloudflare/vinext), Cloudflare's Vite-based
reimplementation of Next.js, including on Cloudflare Workers.

Payload 3 is a Next.js application. This plugin covers where vinext and
workerd differ from Next.js for Payload: dependency pre-bundling, Node
builtins in workerd, CommonJS in the browser and the RSC serializer. The admin
UI, the REST and GraphQL APIs, server actions and uploads run unmodified.

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

Declare `PAYLOAD_SECRET` in `cloudflare.config.ts` with `bindings.secret()`:
the v2 plugin passes only declared secrets to the Worker. Bindings, schema
setup and the template's OpenNext leftovers are covered in the
**[Cloudflare D1 guide](docs/cloudflare-d1.md)**.

### Headless RPC worker

`vinextPayloadWorker()` runs Payload's
[Local API](https://payloadcms.com/docs/local-api/overview) in a Worker
without vinext, the admin UI or HTTP routes. Other Workers call it over a
[service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/),
so their frontend can be anything Vite builds.

```ts
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { vinextPayloadWorker } from "vite-plugin-vinext-payload";

export default defineConfig({
	plugins: [
		cloudflare({ viteEnvironment: { name: "cms" } }),
		...vinextPayloadWorker({ env: "cms" }),
	],
});
```

`env` is the Worker's Vite environment name. Set it explicitly with
`viteEnvironment.name`, as above; otherwise `@cloudflare/vite-plugin` derives
it from the Worker's `name` with `-` replaced by `_`. Running the Worker as one
of another Worker's `auxiliaryWorkers` works the same way: pass that worker's
environment name.

```ts
// src/index.ts
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
}

export default {
	fetch: () => new Response("rpc-only", { status: 404 }),
};
```

`vinextPayloadWorker()` applies the workerd compatibility, optimizeDeps,
`drizzle-kit/api`, `file-type` and CJS patches of `vinextPayload()`, scoped to
`env`. It leaves out the RSC serializer patch and the client-environment
configuration.

## Options

| Option                | Type       | Description                                                                     |
| --------------------- | ---------- | ------------------------------------------------------------------------------- |
| `env`                 | `string`   | **`vinextPayloadWorker()` only, required.** The Worker's Vite environment name. |
| `excludeFromOptimize` | `string[]` | Additional packages to exclude from `optimizeDeps`.                             |

## Requirements

- Node.js `>=24`
- Vite `^8.0.0`
- Payload CMS `^3.82.0`
- vinext `1.4.3`, exact. Every vinext release can move the internals this
  plugin patches. Required by `vinextPayload()` only; `vinextPayloadWorker()`
  runs without it.

## Status

Both vinext and this plugin are experimental.

Validated against Payload `3.92.1`, vinext `1.4.3`, Vite `8.3.5` (Rolldown),
`@cloudflare/vite-plugin` v2 and Node `>=24`, the versions the e2e suites pin in
`test/helpers.ts`. Known upstream bugs are listed in
[`docs/upstream-bugs.md`](docs/upstream-bugs.md).

## Internals

The plugin rewrites other packages' code at build time. Each rewrite is
declared as data (`PATCH_MANIFEST` in [`src/main.ts`](src/main.ts)) and
tabulated in [`docs/internals.md`](docs/internals.md), which a unit test keeps
in sync with the declarations. None of it is needed to use the plugin.

## License

MIT
