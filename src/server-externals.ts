import type { EnvironmentOptions, Plugin, UserConfig } from "vite";
import { SSR_EXTERNAL } from "./payload-packages.ts";

export interface PayloadServerExternalsOptions {
	/**
	 * Additional packages to externalize from server (SSR + RSC) bundling.
	 * Merged with the built-in list (esbuild, wrangler, miniflare, sharp).
	 */
	ssrExternal?: string[];
}

/**
 * Externalizes packages from both the SSR and RSC environments.
 *
 * Why not just `ssr.external`? Two reasons:
 *
 * 1. `ssr.external` only applies to Vite's "ssr" named environment — it
 *    does NOT propagate to RSC. We use `configEnvironment` to apply the
 *    same list to both `ssr` and `rsc`.
 *
 * 2. `@cloudflare/vite-plugin` rejects `resolve.external` on every
 *    environment it manages. We write to `build.rolldownOptions.external`
 *    instead, which the cloudflare plugin leaves alone.
 */
export function payloadServerExternals(
	options: PayloadServerExternalsOptions = {},
): Plugin {
	const { ssrExternal: extraSsrExternal = [] } = options;

	const ssrExternals = [...SSR_EXTERNAL, ...extraSsrExternal];

	return {
		name: "vite-plugin-payload:server-externals",
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
