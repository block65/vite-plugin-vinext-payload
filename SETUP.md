# Payload CMS on vinext

Guide for migrating an existing Payload CMS project from Next.js to vinext, or starting fresh from a template.

## Migrating from Next.js

### Quick path (recommended)

```sh
vinext init                          # Convert Next.js → vinext
npm install -D vite-plugin-vinext-payload
npx vite-plugin-vinext-payload init  # Apply Payload-specific fixes
npm run dev
```

The `init` command adds the plugin to your Vite config, extracts the server function, and fixes the admin page. It's idempotent — safe to run again after updating Payload or regenerating files.

Use `--dry-run` to preview changes.

### What `vite-plugin-vinext-payload init` does

Applies Payload-specific fixes for vinext compatibility:

1. **Adds `payloadPlugin()` to `vite.config.ts`** — import and plugin registration
2. **Extracts `serverFunction.ts`** — Vite's RSC transform requires module-level `'use server'` directives. Payload generates an inline directive inside `layout.tsx` which doesn't get hoisted into the server reference map. The init script extracts it into a separate module.
3. **Adds `normalizeParams` to admin page** — vinext's optional catch-all `[[...segments]]` returns `[]` for `/admin`, but Payload expects `undefined`. Without this fix, `/admin` returns a 404.

### Cloudflare D1 configuration

If deploying to Cloudflare Workers with D1, you also need to update `payload.config.ts` to replace OpenNext's cloudflare context helper:

```ts
// Replace:
import { getCloudflareContext } from "@opennextjs/cloudflare";
const cloudflare = await getCloudflareContext({ async: true });

// With:
async function getCloudflareEnv() {
	try {
		const { env } = await import(/* @vite-ignore */ "cloudflare:workers");
		return env;
	} catch {
		const { getPlatformProxy } = await import("wrangler");
		const proxy = await getPlatformProxy({
			environment: process.env.CLOUDFLARE_ENV,
		});
		return proxy.env;
	}
}

const cfEnv = await getCloudflareEnv();
```

Then replace `cloudflare.env.D1` / `cloudflare.env.R2` with `cfEnv.D1` / `cfEnv.R2`.

The `/* @vite-ignore */` comment prevents Vite from trying to resolve `cloudflare:workers` at build time — it's a Workers runtime built-in that only exists at deploy time.

You should also remove `"remote": true` from `wrangler.jsonc` D1 bindings for local development (it requires Cloudflare auth).

---

## Starting Fresh

### SQLite (simplest)

```sh
npx degit payloadcms/payload/templates/with-postgres my-project
cd my-project
npm install
vinext init
npm install -D vite-plugin-vinext-payload
npx vite-plugin-vinext-payload init
npm run dev
```

Swap `@payloadcms/db-postgres` for `@payloadcms/db-sqlite` in your dependencies and update `payload.config.ts` accordingly.

### Cloudflare D1

```sh
npx degit payloadcms/payload/templates/with-cloudflare-d1 my-project
cd my-project
npm install
vinext init
npm install -D vite-plugin-vinext-payload
npx vite-plugin-vinext-payload init
```

Then apply the [Cloudflare D1 configuration](#cloudflare-d1-configuration) changes to `payload.config.ts` and run `npm run dev`.

Visit `http://localhost:5173/admin` to create your first user.

---

## Reference

### Related discussions

- [payloadcms/payload#15876](https://github.com/payloadcms/payload/discussions/15876) — Vinext compatibility issues filed upstream
- [payloadcms/payload#15761](https://github.com/payloadcms/payload/discussions/15761) — Community discussion on vinext support
