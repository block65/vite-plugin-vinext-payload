import type { Alias, Plugin, ResolvedConfig, UserConfig } from "vite";
import {
	CLIENT_OPTIMIZE_DEPS_EXCLUDE,
	CLIENT_OPTIMIZE_DEPS_INCLUDE,
	OPTIMIZE_DEPS_EXCLUDE,
} from "./payload-packages.ts";

/**
 * Collect all `next/*` alias specifiers from the resolved Vite config.
 *
 * vinext defines aliases like `next/link` → `vinext/dist/shims/link.js`
 * and `next/link.js` → same target. The optimizer treats each specifier
 * independently, so we must include every variant to avoid runtime
 * discovery → full page reload on cold start.
 */
function getNextAliasSpecifiers(
	aliases: ResolvedConfig["resolve"]["alias"],
): string[] {
	const specifiers: string[] = [];

	if (Array.isArray(aliases)) {
		for (const entry of aliases as Alias[]) {
			const find =
				typeof entry.find === "string"
					? entry.find
					: entry.find instanceof RegExp
						? null
						: null;
			if (find?.startsWith("next/")) {
				specifiers.push(find);
			}
		}
	} else if (aliases && typeof aliases === "object") {
		for (const key of Object.keys(aliases as Record<string, unknown>)) {
			if (key.startsWith("next/")) {
				specifiers.push(key);
			}
		}
	}

	return specifiers;
}

export interface PayloadOptimizeDepsOptions {
	/** Additional packages to exclude from optimizeDeps. */
	extraExcludes?: string[];

	/**
	 * Explicit list of environments to patch. When undefined, every env in
	 * `config.environments` that already declares `optimizeDeps` is patched
	 * (vinext default). For headless payload workers, pass the worker's
	 * env name so the excludes apply even if that env didn't pre-declare
	 * `optimizeDeps`.
	 */
	envs?: string[];

	/**
	 * Name of the client-consumer environment that should additionally
	 * receive `CLIENT_OPTIMIZE_DEPS_EXCLUDE`/`CLIENT_OPTIMIZE_DEPS_INCLUDE`
	 * and the auto-discovered `next/*` alias specifiers. Defaults to
	 * `"client"`. Pass `false` for workers with no browser environment.
	 */
	clientEnv?: string | false;
}

/**
 * Returns per-environment optimizeDeps config to exclude problematic
 * packages and force-include CJS transitive deps in the client environment.
 *
 * vinext (and other frameworks using Vite's environments API) creates
 * per-environment configs that replace top-level excludes, so we must
 * patch each environment individually.
 *
 * In `configResolved`, all `next/*` alias specifiers are auto-discovered
 * and added to the client optimizeDeps include list. This prevents the
 * optimizer from discovering them at runtime (which causes a full page
 * reload and duplicate React instances).
 *
 * See: cloudflare/vinext#538
 */
export function payloadOptimizeDeps(
	options: PayloadOptimizeDepsOptions | string[] = {},
): Plugin {
	const normalized: PayloadOptimizeDepsOptions = Array.isArray(options)
		? { extraExcludes: options }
		: options;
	const {
		extraExcludes = [],
		envs: explicitEnvs,
		clientEnv = "client",
	} = normalized;
	const excludes = [...OPTIMIZE_DEPS_EXCLUDE, ...extraExcludes];

	return {
		name: "vite-plugin-payload:optimize-deps",
		enforce: "pre",
		config(config) {
			if (!config.environments) {
				return;
			}

			const targetEnvs = explicitEnvs
				? explicitEnvs
				: Object.entries(config.environments)
						.filter(([_, env]) => env?.optimizeDeps)
						.map(([name]) => name);

			const environments: UserConfig["environments"] = {};

			for (const name of targetEnvs) {
				const env = config.environments[name];
				const existingOptimizeDeps = env?.optimizeDeps ?? {};

				const envExcludes = [
					...excludes,
					...(name === clientEnv ? CLIENT_OPTIMIZE_DEPS_EXCLUDE : []),
				];

				environments[name] = {
					optimizeDeps: {
						exclude: [...(existingOptimizeDeps.exclude ?? []), ...envExcludes],
						...(name === clientEnv && {
							include: [
								...(existingOptimizeDeps.include ?? []),
								...CLIENT_OPTIMIZE_DEPS_INCLUDE,
							],
						}),
					},
				};
			}

			return { environments };
		},

		configResolved(config) {
			if (clientEnv === false) {
				return;
			}
			const nextAliases = getNextAliasSpecifiers(config.resolve.alias);
			if (nextAliases.length === 0) {
				return;
			}

			const resolvedClient = config.environments?.[clientEnv];
			if (!resolvedClient) {
				return;
			}

			const include = resolvedClient.optimizeDeps.include ?? [];
			resolvedClient.optimizeDeps.include = include;
			const existing = new Set(include);
			for (const specifier of nextAliases) {
				if (!existing.has(specifier)) {
					include.push(specifier);
				}
			}
		},
	};
}
