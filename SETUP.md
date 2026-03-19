# Payload CMS on vinext

Guide for migrating an existing Payload CMS project from Next.js to vinext, or starting fresh from a template.

## Migrating from Next.js

### Quick path (recommended)

```sh
vinext init                          # Convert Next.js → vinext
pnpm add vite-plugin-payload
npx vite-plugin-payload init         # Apply Payload-specific fixes
pnpm dev
```

The `init` command handles everything: adds the plugin to your Vite config, extracts the server function, fixes the admin page, and wires up the config paths. It's idempotent — run it again after updating Payload or regenerating files.

Use `--dry-run` to preview changes.

### What `vite-plugin-payload init` does

Applies Payload-specific fixes for vinext compatibility:

1. **Adds `payloadPlugin()` to `vite.config.ts`** — import and plugin registration
2. **Extracts `serverFunction.ts`** — Vite's RSC transform requires module-level `'use server'` directives. Payload generates an inline directive inside `layout.tsx` which doesn't get hoisted into the server reference map. The init script extracts it into a separate module.
3. **Adds `normalizeParams` to admin page** — vinext's optional catch-all `[[...segments]]` returns `[]` for `/admin`, but Payload expects `undefined`. Without this fix, `/admin` returns a 404.

### Cloudflare D1 configuration

If deploying to Cloudflare Workers with D1, you also need to update `payload.config.ts` to use the Workers environment API instead of OpenNext's:

```ts
// Replace:
import { getCloudflareContext } from "@opennextjs/cloudflare";
const cloudflare = await getCloudflareContext({ async: true });

// With:
async function getCloudflareEnv(): Promise<CloudflareEnv> {
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

The `/* @vite-ignore */` comment prevents Vite from trying to resolve `cloudflare:workers` at build time — it's a Workers runtime built-in that only exists at deploy time.

---

## Starting Fresh

Use the [payload-d1-vinext](../payload-d1-vinext/) demo as a template:

```sh
cp -r payload-d1-vinext my-project
cd my-project
pnpm install
pnpm dev
```

Visit `http://localhost:5173/admin` to create your first user.

---

## Reference

### Working demo

See [payload-d1-vinext](../payload-d1-vinext/) — a complete Payload CMS app on vinext with Cloudflare D1 + R2 storage.

### Related discussions

- [payloadcms/payload#15876](https://github.com/payloadcms/payload/discussions/15876) — Vinext compatibility issues filed upstream
- [payloadcms/payload#15761](https://github.com/payloadcms/payload/discussions/15761) — Community discussion on vinext support
