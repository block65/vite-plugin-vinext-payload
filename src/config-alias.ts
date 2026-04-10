import type { EnvironmentOptions, Plugin, UserConfig } from "vite";
import { SSR_EXTERNAL } from "./payload-packages.ts";

export interface PayloadConfigAliasOptions {
	/**
	 * Additional packages to externalize from SSR bundling.
	 * Merged with the built-in list (esbuild, wrangler, miniflare, sharp).
	 */
	ssrExternal?: string[];
}

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
					rolldownOptions: {
						external: ["cloudflare:workers"],
					},
				},
			} satisfies UserConfig;
		},
		configEnvironment(name, _config) {
			// @cloudflare/vite-plugin rejects resolve.external on ALL
			// environments it manages (both RSC and SSR). Use
			// build.rolldownOptions.external instead for both.
			// ssr.external also does NOT propagate to RSC — it only applies
			// to the "ssr" named environment in Vite's Environment API.
			if (name === "ssr" || name === "rsc") {
				return {
					build: {
						rolldownOptions: {
							external: ssrExternals,
						},
					},
				} satisfies EnvironmentOptions;
			}
		},
	};
}
