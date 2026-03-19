import type { Plugin, UserConfig } from "vite";

/**
 * Packages excluded from optimizeDeps in ALL environments.
 */
const OPTIMIZE_DEPS_EXCLUDE = [
	// `{ "node": "./index.js", "default": "./core.js" }` — RSC resolves to
	// core.js which lacks `fileTypeFromFile`. See payloadcms/payload#15002.
	"file-type",
	// References `./node.js` expecting directory resolution (`./node/index.js`)
	// but esbuild treats it as a file path.
	"blake3-wasm",
	// No root "." export — only subpath exports like ./layouts, ./routes.
	// Vite's dedup wrapper (`export * from "@payloadcms/next"`) fails.
	"@payloadcms/next",
];

/**
 * Server-side packages excluded from CLIENT optimizeDeps only.
 *
 * These packages contain small "use client" components (e.g. upload
 * handlers) but are predominantly server code. Pre-bundling merges the
 * entire package into one chunk — when RSC proxies a client component
 * back to the browser, it loads the whole server-heavy chunk and fails.
 *
 * Excluding from client optimizeDeps lets the RSC proxy load just the
 * individual client component file directly.
 *
 * WORKAROUND for vinext#581 (clientReferenceDedupPlugin maps files to
 * package root) and vinext#409 (module duplication between RSC refs and
 * pre-bundled paths). Remove once vinext resolves these issues.
 */
const CLIENT_OPTIMIZE_DEPS_EXCLUDE = [
	"@payloadcms/storage-r2",
	"@payloadcms/richtext-lexical",
];

/**
 * CJS transitive deps that must be explicitly included in CLIENT
 * optimizeDeps when their parent packages are excluded above.
 *
 * Excluding a parent prevents Vite from auto-discovering its deps for
 * pre-bundling. The `parent > dep` syntax resolves the dep from the
 * parent's node_modules, bypassing pnpm strict isolation.
 *
 * WORKAROUND: Remove when vinext#581/#409 are resolved and the parent
 * excludes above are no longer needed.
 */
const CLIENT_OPTIMIZE_DEPS_INCLUDE = [
	// ajv — CJS with require() calls, used by payload/fields/validations
	"payload > ajv",
	// bson-objectid — CJS module.exports, used by payload/utilities/isValidID
	"payload > bson-objectid",
	// react/compiler-runtime — CJS stub with require(), used by @payloadcms/ui
	// components compiled with React Compiler. Without pre-bundling, the browser
	// gets the raw CJS file via /@fs/ and can't import named exports.
	"react/compiler-runtime",
];

/**
 * Returns per-environment optimizeDeps config to exclude problematic
 * packages and force-include CJS transitive deps in the client environment.
 *
 * vinext (and other frameworks using Vite's environments API) creates
 * per-environment configs that replace top-level excludes, so we must
 * patch each environment individually.
 *
 * See: cloudflare/vinext#538
 */
export function payloadOptimizeDeps(extraExcludes: string[] = []): Plugin {
	const excludes = [...OPTIMIZE_DEPS_EXCLUDE, ...extraExcludes];

	return {
		name: "vite-plugin-payload:optimize-deps",
		enforce: "pre",
		config(config) {
			if (!config.environments) {
				return;
			}

			const environments: UserConfig["environments"] = {};

			for (const [name, env] of Object.entries(config.environments)) {
				if (!env?.optimizeDeps) {
					continue;
				}

				const envExcludes =
					name === "client"
						? [...excludes, ...CLIENT_OPTIMIZE_DEPS_EXCLUDE]
						: excludes;

				environments[name] = {
					optimizeDeps: {
						exclude: [...(env.optimizeDeps.exclude ?? []), ...envExcludes],
						...(name === "client" && {
							include: [
								...(env.optimizeDeps.include ?? []),
								...CLIENT_OPTIMIZE_DEPS_INCLUDE,
							],
						}),
					},
				};
			}

			return { environments };
		},
	};
}
