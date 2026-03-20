import type { EnvironmentOptions, Plugin, UserConfig } from "vite";

export interface PayloadConfigAliasOptions {
	/**
	 * Additional packages to externalize from SSR bundling.
	 * Merged with the built-in list (graphql, drizzle-kit, pino).
	 */
	ssrExternal?: string[];
}

const SSR_EXTERNAL = [
	"graphql",
	"graphql-http",
	"drizzle-kit",
	"drizzle-kit/api",
	"esbuild",
	"pino",
	"wrangler",
	"miniflare",
	// Workers runtime built-in — not resolvable by Vite's dependency scanner.
	"cloudflare:workers",
	// Native addon — CJS with circular TDZ issues under Vite's module runner.
	"sharp",
	// CJS packages that need Node.js native interop — externalizing is
	// more reliable than transform-based interop (which doesn't reach RSC).
	"pluralize",
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
					external: ssrExternals,
				},
			} satisfies UserConfig;
		},
		// configEnvironment runs per-environment AFTER all environments are
		// created (including those added by vite-plugin-cloudflare for RSC).
		// The earlier `config` hook can't see those environments yet.
		configEnvironment(name, config) {
			if (name === "client") {
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
