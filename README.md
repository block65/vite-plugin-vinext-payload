# vite-plugin-payload

Vite plugin for running [Payload CMS](https://payloadcms.com/) with [vinext](https://github.com/cloudflare/vinext).

Payload CMS assumes a Next.js/webpack environment. This plugin handles the CJS interop, module resolution, optimizeDeps configuration, and server action fixes needed to run Payload on Vite.

## Migrating from Next.js

If you have an existing Payload CMS project on Next.js:

```sh
vinext init                          # Convert Next.js → vinext
pnpm add vite-plugin-payload
npx vite-plugin-payload init         # Apply Payload-specific fixes
pnpm dev
```

The `init` command is idempotent — safe to run multiple times. It:

- Adds `payloadPlugin()` to your `vite.config.ts`
- Extracts the inline server function from `layout.tsx` into a separate `'use server'` module (required for Vite's RSC transform)
- Adds `normalizeParams` to the admin page (fixes `/admin` 404)

Use `--dry-run` to preview changes without writing files.

## Quick Start

If you've already run `init`, or are setting up manually:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { payloadPlugin } from "vite-plugin-payload";

export default defineConfig({
	plugins: [vinext(), payloadPlugin()],
});
```

## Options

```ts
payloadPlugin({
	// Path to your payload.config.ts (default: "./src/payload.config.ts")
	configPath: "./src/payload.config.ts",

	// Additional packages to externalize from SSR bundling
	ssrExternal: ["some-cjs-package"],

	// Additional packages to exclude from optimizeDeps
	excludeFromOptimize: ["some-broken-package"],

	// Additional CJS packages needing default export interop
	cjsInteropDeps: ["some-cjs-dep"],
});
```

## What It Does

`payloadPlugin()` composes six sub-plugins:

| Plugin                   | What it does                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payloadConfigAlias`     | Configures SSR externals for all environments (including RSC)                                                                                                                 |
| `payloadOptimizeDeps`    | Excludes problematic packages from Vite's pre-bundling and force-includes CJS transitive deps in the client environment                                                       |
| `payloadCjsTransform`    | Single-pass transform that fixes `this` → `globalThis` in UMD/CJS wrappers and wraps `module.exports` files with ESM scaffolding for the browser                              |
| `payloadCliStubs`        | Stubs packages not needed at web runtime (`console-table-printer`, `json-schema-to-typescript`, `esbuild-register`, `ws`) to no-ops                                           |
| `payloadServerActionFix` | Fixes vinext's server action re-render loop by reordering `reactRoot.render()` after the `returnValue` check (AST-based via ast-grep)                                         |
| `cjsInterop`             | Fixes CJS default export interop for packages like `pluralize` and `bson-objectid` (via [vite-plugin-cjs-interop](https://github.com/nicolo-ribaudo/vite-plugin-cjs-interop)) |

## A La Carte

Import individual plugins if you need fine-grained control:

```ts
import {
	payloadConfigAlias,
	payloadOptimizeDeps,
	payloadCjsTransform,
	payloadCliStubs,
	payloadServerActionFix,
	payloadCjsInteropDeps,
} from "vite-plugin-payload";

export default defineConfig({
	plugins: [
		vinext(),
		payloadConfigAlias({ configPath: "./payload.config.ts" }),
		payloadOptimizeDeps(),
		payloadCjsTransform(),
		payloadCliStubs(),
		payloadServerActionFix(),
	],
});
```

## Why This Exists

Payload CMS is built on Next.js and relies heavily on CJS packages and Node.js module resolution. When running on Vite via vinext, several things break:

- CJS packages served via `/@fs/` aren't converted to ESM — browsers choke on `module.exports`
- UMD wrappers use `this` at module scope, which is `undefined` in Vite's strict ESM environment
- CLI-only packages (`console-table-printer`, `json-schema-to-typescript`) pull in Node.js APIs that break in the browser and Workers
- Server actions trigger infinite re-render loops because vinext re-renders the tree before checking return values
- Per-environment `optimizeDeps` configuration is needed because vinext creates separate client, SSR, and RSC environments

This plugin handles all of that so your `vite.config.ts` stays clean.

For detailed manual setup steps and Cloudflare D1 configuration, see **[SETUP.md](SETUP.md)**.

## License

MIT
