import type { EnvironmentOptions, Plugin, UserConfig } from "vite";
import type { PatchDeclaration } from "./patch-manifest.ts";
import { SSR_EXTERNAL } from "./payload-packages.ts";

export const serverExternalsPatch = {
	id: "server-externals",
	kind: "config",
	targets: [
		"esbuild, wrangler, miniflare, sharp — externalized from server bundles",
		"cloudflare:workers — externalized everywhere",
	],
	reason:
		"build/deploy tools and native addons cannot be bundled, and the client environment must not try to bundle the workerd-only cloudflare:workers specifier",
	removeWhen: "never — build tools and native addons stay external",
} satisfies PatchDeclaration;

export interface PayloadServerExternalsOptions {
	/**
	 * Additional packages to externalize from server bundling.
	 * Merged with the built-in list (esbuild, wrangler, miniflare, sharp).
	 */
	ssrExternal?: string[];

	/**
	 * Names of Vite environments that should receive the server externals
	 * list via `build.rolldownOptions.external`. Defaults to `["ssr", "rsc"]`
	 * to match vinext's environment layout. For payload running as an
	 * auxiliary Cloudflare worker, pass the worker's environment name(s).
	 */
	serverEnvs?: string[];
}

/**
 * Externalizes packages from server-side environments via
 * `build.rolldownOptions.external` (per-environment, set in
 * `configEnvironment`).
 *
 * We deliberately do NOT set `ssr.external` (or any
 * `environments.<name>.resolve.external`): `@cloudflare/vite-plugin`
 * rejects user-set `resolve.external` on every environment it manages
 * and throws `validateWorkerEnvironmentOptions`. The cloudflare plugin
 * supplies its own workerd-aware externals; our list only needs to
 * survive the production bundle, which `build.rolldownOptions.external`
 * accomplishes.
 *
 * `cloudflare:workers` is also added to the top-level
 * `build.rolldownOptions.external` so the client environment doesn't
 * try to bundle this workerd-only specifier when transitively reached.
 */
export function payloadServerExternals(
	options: PayloadServerExternalsOptions = {},
): Plugin {
	const { ssrExternal: extraSsrExternal = [], serverEnvs = ["ssr", "rsc"] } =
		options;

	const ssrExternals = [...SSR_EXTERNAL, ...extraSsrExternal];
	const serverEnvSet = new Set(serverEnvs);

	return {
		name: "vite-plugin-payload:server-externals",
		config() {
			return {
				build: {
					rolldownOptions: {
						external: ["cloudflare:workers"],
					},
				},
			} satisfies UserConfig;
		},
		configEnvironment(name, _config) {
			if (serverEnvSet.has(name)) {
				return {
					build: {
						rolldownOptions: {
							external: [...ssrExternals, "cloudflare:workers"],
						},
					},
				} satisfies EnvironmentOptions;
			}
		},
	};
}
