import type { Plugin, UserConfig } from "vite";

/**
 * Packages excluded from optimizeDeps in ALL environments.
 *
 * In RSC, `file-type` is additionally intercepted by the esbuild resolve
 * plugin in {@link payloadRscStubs} — the plugin runs before the external
 * check, so `file-type` is inlined from a stub rather than left as an
 * unresolvable bare import in the pre-bundled output.
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
 * pre-bundled paths). The real fix is tracked upstream in
 * vitejs/vite-plugin-react#775 (@vitejs/plugin-rsc 3rd party compat).
 * Remove once that lands.
 */
// Packages with "use client" components that must NOT be pre-bundled
// in the CLIENT environment — excluding breaks plugin-rsc's client
// package proxy ("Failed to fetch dynamically imported module").
const CLIENT_OPTIMIZE_DEPS_EXCLUDE: string[] = [];

/**
 * Packages excluded from RSC optimizeDeps only.
 *
 * These packages have barrel re-exports pointing to "use client" modules.
 * Pre-bundling merges everything into one chunk, stripping the "use client"
 * directive. plugin-rsc can't detect the client boundary and executes the
 * component on the server (where React hooks don't exist).
 *
 * Excluding from RSC lets the individual files go through the transform
 * pipeline where plugin-rsc's `rsc:use-client` transform detects the
 * directive and creates proper client references.
 */
const RSC_OPTIMIZE_DEPS_EXCLUDE = ["@payloadcms/storage-r2"];

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

				const envExcludes = [
					...excludes,
					...(name === "client" ? CLIENT_OPTIMIZE_DEPS_EXCLUDE : []),
					...(name === "rsc" ? RSC_OPTIMIZE_DEPS_EXCLUDE : []),
				];

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
