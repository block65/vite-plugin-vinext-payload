import type { EnvironmentOptions, Plugin, ResolvedConfig } from "vite";
import type { PatchDeclaration } from "./patch-manifest.ts";
import {
	CLIENT_OPTIMIZE_DEPS_EXCLUDE,
	CLIENT_OPTIMIZE_DEPS_INCLUDE,
	OPTIMIZE_DEPS_EXCLUDE,
} from "./payload-packages.ts";

export const optimizeDepsPatch = {
	id: "optimize-deps",
	kind: "config",
	targets: [
		"file-type, blake3-wasm, wrangler, @payloadcms/next — excluded from optimizeDeps in every environment",
		"payload > ajv, payload > bson-objectid, react/compiler-runtime, @payloadcms/ui and discovered next/* aliases — force-included in client optimizeDeps",
	],
	reason:
		"these packages break during esbuild/Rolldown pre-bundling for structural reasons webpack handles natively, and excluded parents lose CJS auto-discovery for their children; per-entry notes live in payload-packages.ts",
	upstreamIssues: ["https://github.com/cloudflare/vinext/issues/538"],
	removeWhen:
		"per-entry conditions in payload-packages.ts — the lists shrink entry by entry",
} satisfies PatchDeclaration;

export interface PayloadOptimizeDepsOptions {
	/** Additional packages to exclude from optimizeDeps. */
	extraExcludes?: string[];

	/**
	 * Explicit list of environments to patch. When undefined, every env in
	 * `config.environments` is patched.
	 *
	 * This used to patch only environments that already declared
	 * `optimizeDeps`, inferring "this environment optimizes" from the
	 * framework's config shape. Both vinext 0.1.3 (`dist/index.js`: rsc 862,
	 * ssr 879, client 890) and 1.0.0-beta.2 (rsc 1307, ssr 1330, client 1342,
	 * inside `if (hasAppDir)`) do declare them — but the coupling is fragile:
	 * the line numbers moved across one minor, the declarations are
	 * conditional, and an environment created after our `enforce: "pre"`
	 * `config` hook (as `@cloudflare/vite-plugin` does) is invisible to it.
	 *
	 * Excludes are cheap on an environment that never optimizes, so patch
	 * unconditionally rather than inferring intent from the config shape.
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
	// RegExp `find` entries have no single specifier to pre-bundle, so only
	// string finds contribute.
	const candidates = Array.isArray(aliases)
		? aliases.map((entry) => entry.find)
		: Object.keys(aliases);

	return candidates.flatMap((find) =>
		typeof find === "string" && find.startsWith("next/") ? [find] : [],
	);
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
		// `configEnvironment` rather than `config`, for the same reason
		// payloadServerExternals uses it: it fires once per environment, after
		// every plugin has declared its own, including environments created
		// later than our `enforce: "pre"` `config` hook runs.
		//
		// NB: this did NOT fix the `blake3-wasm` failure that motivated it —
		// see docs/d1-dev-boot-investigation.md. That cause is still open.
		configEnvironment(name, envConfig) {
			if (explicitEnvs && !explicitEnvs.includes(name)) {
				return;
			}

			const existingOptimizeDeps = envConfig.optimizeDeps ?? {};

			const envExcludes = [
				...excludes,
				...(name === clientEnv ? CLIENT_OPTIMIZE_DEPS_EXCLUDE : []),
			];

			return {
				optimizeDeps: {
					exclude: [...(existingOptimizeDeps.exclude ?? []), ...envExcludes],
					...(name === clientEnv && {
						include: [
							...(existingOptimizeDeps.include ?? []),
							...CLIENT_OPTIMIZE_DEPS_INCLUDE,
						],
					}),
				},
			} satisfies EnvironmentOptions;
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
			const existing = new Set(include);

			resolvedClient.optimizeDeps.include = [
				...include,
				...nextAliases.filter((specifier) => !existing.has(specifier)),
			];
		},
	};
}
