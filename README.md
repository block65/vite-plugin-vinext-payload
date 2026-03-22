# vite-plugin-vinext-payload

Vite plugin for running [Payload CMS](https://payloadcms.com/) with [vinext](https://github.com/cloudflare/vinext) (Cloudflare's Vite-based re-implementation of Next.js).

> **Experimental.** Both vinext and this plugin are experimental. Tested with Payload 3.80.0, vinext 0.0.33, and Vite 8 (Rolldown).

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

For Cloudflare D1 projects, see **[Cloudflare D1 guide](docs/cloudflare-d1.md)** for additional configuration.

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

For Cloudflare Workers with RSC:

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
		payloadPlugin({
			ssrExternal: ["cloudflare:workers"],
		}),
	],
});
```

## Options

```ts
payloadPlugin({
	// Additional packages to externalize from SSR bundling
	ssrExternal: ["some-native-package"],

	// Additional packages to exclude from optimizeDeps
	excludeFromOptimize: ["some-broken-package"],

	// Additional CJS packages needing default export interop
	cjsInteropDeps: ["some-cjs-dep"],
});
```

## What It Does

`payloadPlugin()` composes these sub-plugins:

| Plugin | What it does |
| --- | --- |
| `payloadUseClientBarrel` | Auto-detects `@payloadcms/*` barrel files that re-export from `'use client'` modules and excludes them from RSC pre-bundling (pre-bundling strips the directive, breaking client references) |
| `payloadConfigAlias` | Configures SSR externals — only build tools and native addons are externalized (workerd can't resolve externals at runtime) |
| `payloadOptimizeDeps` | Per-environment optimizeDeps: excludes problematic packages, force-includes CJS transitive deps for the client |
| `payloadCjsTransform` | Fixes `this` → `globalThis` in UMD/CJS wrappers and wraps `module.exports` with ESM scaffolding (skips React/ReactDOM which Vite 8 handles natively) |
| `payloadCliStubs` | Stubs packages not needed at web runtime (`console-table-printer`, `json-schema-to-typescript`, `esbuild-register`, `ws`) |
| `payloadRscExportFix` | Fixes `@vitejs/plugin-rsc`'s CSS export transform dropping exports after sourcemap comments |
| `payloadRscStubs` | Stubs `file-type` and `drizzle-kit/api` for RSC/workerd (Node.js APIs unavailable), polyfills workerd's broken `console.createTask` |
| `payloadServerActionFix` | Fixes vinext's server action re-render loop by reordering `reactRoot.render()` (AST-based via ast-grep) |
| `cjsInterop` | Fixes CJS default export interop for packages like `bson-objectid` (via [vite-plugin-cjs-interop](https://github.com/nicolo-ribaudo/vite-plugin-cjs-interop)) |

## A La Carte

Import individual plugins if you need fine-grained control:

```ts
import {
	payloadUseClientBarrel,
	payloadConfigAlias,
	payloadOptimizeDeps,
	payloadCjsTransform,
	payloadCliStubs,
	payloadRscExportFix,
	payloadRscStubs,
	payloadServerActionFix,
} from "vite-plugin-vinext-payload";
```

## Requirements

- Node.js >= 24
- Vite 6, 7, or 8
- vinext 0.0.33+
- Payload CMS 3.x

## Known Upstream Issues

These are bugs in dependencies that this plugin works around. See [`docs/upstream-bugs.md`](docs/upstream-bugs.md) for details and ownership.

| Issue | Owner | Our workaround |
| --- | --- | --- |
| `'use client'` not detected through barrel re-exports | @vitejs/plugin-rsc | Auto-exclude affected packages from RSC optimizeDeps |
| RSC export transform drops exports after sourcemap comments | @vitejs/plugin-rsc | Post-transform newline insertion |
| `console.createTask` throws "not implemented" | workerd | Try/catch polyfill |
| `file-type` / `drizzle-kit/api` unresolvable in workerd | pnpm + Vite | Stub modules for RSC |

## License

MIT
