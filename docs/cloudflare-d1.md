# Cloudflare Workers + D1

Running Payload's
[`with-cloudflare-d1`](https://github.com/payloadcms/payload/tree/main/templates/with-cloudflare-d1)
template on vinext's default Cloudflare setup: `@cloudflare/vite-plugin` v2
with a `cloudflare.config.ts`, as `vinext init --platform=cloudflare` writes
it. The template ships for OpenNext; remove `@opennextjs/cloudflare`,
`open-next.config.ts` and `wrangler.jsonc` first, because vinext's init will not
replace a Wrangler config.

## Bindings

Declare the template's bindings in the `env` of the generated
`cloudflare.config.ts`:

```ts
env: {
	...cache.env,
	ASSETS: bindings.assets(),
	D1: bindings.d1(),
	R2: bindings.r2(),
	PAYLOAD_SECRET: bindings.secret(),
},
```

`PAYLOAD_SECRET` must be declared. The v2 plugin passes only declared secrets
to the Worker, reading their local values from `.dev.vars` or `.env`. Payload
reads `process.env.PAYLOAD_SECRET`, which `nodejs_compat` populates from the
Worker's env.

## Reading bindings in `payload.config.ts`

Replace the template's `getCloudflareContext` with the `cloudflare:workers`
env. The `catch` covers Payload's Node CLI (`payload generate:importmap`), which
loads the config outside workerd:

```ts
async function getCloudflareEnv(): Promise<CloudflareEnv> {
	try {
		const { env } = await import(/* @vite-ignore */ "cloudflare:workers");
		return env;
	} catch {
		return {} as CloudflareEnv;
	}
}

const cfEnv = await getCloudflareEnv();
```

```diff
- db: sqliteD1Adapter({ binding: cloudflare.env.D1 }),
+ db: sqliteD1Adapter({ binding: cfEnv.D1 }),

- bucket: cloudflare.env.R2,
+ bucket: cfEnv.R2,
```

Drop the template's `fs`, `realpath` and `isCLI` helpers and the
`getCloudflareContextFromWrangler` function along with it.

## Schema

In `vite dev`, Payload pushes its schema to the local D1 database on first
request, as it does under Next.js. The Node CLI gets no D1 binding under this
setup, so `payload migrate` cannot reach the database.

## Top-level binding assertions

Cloudflare executes the module during upload validation, before bindings are
populated. A top-level `assert(cfEnv.D1)` crashes the upload; read bindings at
request time instead.
