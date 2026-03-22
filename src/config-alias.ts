import type { EnvironmentOptions, Plugin, UserConfig } from "vite";

export interface PayloadConfigAliasOptions {
	/**
	 * Additional packages to externalize from SSR bundling.
	 * Merged with the built-in list (graphql, drizzle-kit, pino).
	 */
	ssrExternal?: string[];
}

// Packages that should only be externalized, not bundled.
// IMPORTANT: ssr.external applies to ALL server environments including
// RSC. In workerd, externalized packages can't be resolved — only
// packages that are truly build-time-only or native addons belong here.
// Runtime CJS packages must be bundled (handled by optimizeDeps).
const SSR_EXTERNAL = [
	"esbuild",
	"wrangler",
	"miniflare",
	// Native addon — CJS with circular TDZ issues under Vite's module runner.
	"sharp",
];

/**
 * Configures SSR externals and propagates them to all server environments
 * (including RSC).
 */
export function payloadConfigAlias(
	options: PayloadConfigAliasOptions = {},
): Plugin {
	const { ssrExternal: extraSsrExternal = [] } = options;

	const ssrExternals = [...SSR_EXTERNAL, ...extraSsrExternal];

	return {
		name: "vite-plugin-payload:ssr-externals",
		config() {
			return {
				ssr: {
					external: [...ssrExternals, "cloudflare:workers"],
				},
				build: {
					rollupOptions: {
						external: ["cloudflare:workers"],
					},
				},
			} satisfies UserConfig;
		},
		// Apply resolve.external only to the SSR environment.
		// Skip RSC — @cloudflare/vite-plugin rejects resolve.external on
		// environments it manages, and it may own RSC via viteEnvironment.
		// The top-level ssr.external from the config hook already covers
		// server-side externals for both environments.
		configEnvironment(name, config) {
			if (name !== "ssr") {
				return;
			}
			return {
				resolve: {
					external: [
						...((config.resolve?.external as string[]) ?? []),
						...ssrExternals,
					],
				},
			} satisfies EnvironmentOptions;
		},
	};
}
