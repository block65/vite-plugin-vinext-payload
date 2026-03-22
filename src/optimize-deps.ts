import type { Plugin, UserConfig } from "vite";
import {
	CLIENT_OPTIMIZE_DEPS_EXCLUDE,
	CLIENT_OPTIMIZE_DEPS_INCLUDE,
	OPTIMIZE_DEPS_EXCLUDE,
} from "./payload-packages.ts";

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
