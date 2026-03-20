# vite-plugin-vinext-payload

Vite plugin for running [Payload CMS](https://payloadcms.com/) with [vinext](https://github.com/cloudflare/vinext) (Cloudflare's Vite-based re-implementation of Next.js).

> **Experimental.** Both vinext and this plugin are experimental. Tested with Payload 3.77.0, vinext 0.0.31, and Vite 7. Vite 8 is not yet supported.

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
- Adds `normalizeParams` to the admin page (fixes `/admin` 404)

Use `--dry-run` to preview changes without writing files.

For Cloudflare D1 projects, see **[SETUP.md](SETUP.md)** for additional configuration.

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

## Options

```ts
payloadPlugin({
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
} from "vite-plugin-vinext-payload";

export default defineConfig({
	plugins: [
		vinext(),
		payloadConfigAlias(),
		payloadOptimizeDeps(),
		payloadCjsTransform(),
		payloadCliStubs(),
		payloadServerActionFix(),
	],
});
```

## Requirements

- Node.js >= 24
- Vite 6 or 7 (Vite 8 is not yet supported)
- vinext 0.0.31+
- Payload CMS 3.x

## Why This Exists

Payload CMS is built on Next.js and relies heavily on CJS packages and Node.js module resolution. When running on Vite via vinext, several things break:

- CJS packages served via `/@fs/` aren't converted to ESM — browsers choke on `module.exports`
- UMD wrappers use `this` at module scope, which is `undefined` in Vite's strict ESM environment
- CLI-only packages (`console-table-printer`, `json-schema-to-typescript`) pull in Node.js APIs that break in the browser and Workers
- Server actions trigger infinite re-render loops because vinext re-renders the tree before checking return values
- Per-environment `optimizeDeps` configuration is needed because vinext creates separate client, SSR, and RSC environments

This plugin handles all of that so your `vite.config.ts` stays clean.

## License

MIT
