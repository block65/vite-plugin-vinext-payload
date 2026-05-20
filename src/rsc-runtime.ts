import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import type { EnvironmentOptions, Plugin } from "vite";
import { RSC_STUBS } from "./payload-packages.ts";

// Static stub files — these must export the named exports that consumers
// expect. Dynamic empty stubs don't work because Rolldown checks for
// MISSING_EXPORT on named imports like { fileTypeFromFile }.
const STUB_FILES: Record<string, string> = {
	"file-type": fileURLToPath(new URL("./stubs/file-type.js", import.meta.url)),
	"drizzle-kit/api": fileURLToPath(
		new URL("./stubs/drizzle-kit-api.js", import.meta.url),
	),
};

// Inline stub for createRequire-based requires of drizzle-kit/api.
// resolveId hooks can't intercept createRequire() calls — they produce
// a runtime Node.js require that bypasses all bundler resolution.
// We transform the source during pre-bundling to inline no-op stubs.
const DRIZZLE_KIT_API_INLINE_STUB = [
	"({",
	"  generateSQLiteDrizzleJson: () => ({}),",
	"  generateSQLiteMigration: async () => [],",
	"  pushSQLiteSchema: async () => ({ apply: async () => {}, hasDataLoss: false, warnings: [] }),",
	"  generateDrizzleJson: () => ({}),",
	"  generateMigration: async () => [],",
	"  pushSchema: async () => ({ apply: async () => {}, hasDataLoss: false, warnings: [] }),",
	"})",
].join(" ");

// Build the stub path map from the curated list + static files
const stubPaths: Record<string, string> = Object.fromEntries(
	Object.keys(RSC_STUBS)
		.filter((pkg) => pkg in STUB_FILES)
		.map((pkg) => [pkg, STUB_FILES[pkg]]),
);

export interface PayloadRscRuntimeOptions {
	/**
	 * Names of server environments running on workerd that need
	 * `file-type` and `drizzle-kit/api` stubbed. Both are pulled in
	 * transitively by `@payloadcms/db-d1-sqlite` but never invoked in
	 * production; without stubs the pre-bundled chunk contains a bare
	 * `import 'file-type'` that the workerd module runner can't resolve.
	 * Defaults to `["rsc"]`.
	 */
	serverEnvs?: string[];

	/**
	 * Name of the environment that needs the RSC serializer patch
	 * (`react-server-dom-webpack` "Client Component" throw → return
	 * undefined). Pass `false` for workers that don't render RSC.
	 * Defaults to `"rsc"`.
	 */
	rscEnv?: string | false;
}

/**
 * Server-side workerd runtime patches.
 *
 * Two concerns:
 *
 * - **Stubs** for `file-type` and `drizzle-kit/api` in any server env
 *   running on workerd (default `rsc`, extended for headless payload
 *   workers). Both are transitively imported by
 *   `@payloadcms/db-d1-sqlite` but never invoked at runtime.
 *
 * - **RSC serializer patch** that converts the "Client Component" throw
 *   in `react-server-dom-webpack` into `return undefined`. Applies only
 *   to the configured RSC env (default `rsc`), skipped entirely when
 *   `rscEnv` is `false`.
 */
export function payloadRscRuntime(
	options: PayloadRscRuntimeOptions = {},
): Plugin {
	const { serverEnvs = ["rsc"], rscEnv = "rsc" } = options;
	const serverEnvSet = new Set(serverEnvs);

	return {
		name: "vite-plugin-payload:rsc-runtime",
		// `enforce: "pre"` is load-bearing for the stub `resolveId` hook below.
		// Without it, Vite's default Node resolver claims bare specifiers like
		// `file-type` first and points them at the real package's `core.js` —
		// which doesn't export `fileTypeFromFile`, so Rolldown then errors
		// with MISSING_EXPORT before our stub redirect ever runs. This only
		// surfaces under `payloadWorkerPlugin` with a real payload import
		// (which the original e2e didn't exercise).
		enforce: "pre",

		// Redirect stubs during optimizeDeps pre-bundling so they're
		// inlined rather than left as bare external imports that workerd
		// can't resolve.
		configEnvironment(name) {
			if (!serverEnvSet.has(name)) {
				return;
			}

			const stubs = stubPaths;

			return {
				optimizeDeps: {
					// Vite 8+ (Rolldown) — added via spread to avoid type
					// errors on Vite versions that don't have the type yet
					...({
						rolldownOptions: {
							plugins: [
								{
									name: "payload-rsc-runtime-stubs",
									resolveId(source: string) {
										return stubs[source] ?? null;
									},
									transform(code: string) {
										if (!code.includes("drizzle-kit/api")) {
											return null;
										}
										const replaced = code.replace(
											/require\s*\(\s*['"]drizzle-kit\/api['"]\s*\)/g,
											DRIZZLE_KIT_API_INLINE_STUB,
										);
										if (replaced === code) {
											return null;
										}
										return { code: replaced, map: null };
									},
								},
							],
						},
					} as Record<string, unknown>),
				},
			} satisfies EnvironmentOptions;
		},

		transform: {
			handler(code, id) {
				const envName = this.environment?.name;
				if (!envName) {
					return;
				}
				const isServerEnv = serverEnvSet.has(envName);
				const isRscEnv = rscEnv !== false && envName === rscEnv;
				if (!isServerEnv && !isRscEnv) {
					return;
				}

				let result = code;

				// createRequire-based requires bypass resolveId — catch at
				// transform time for non-pre-bundled modules.
				if (isServerEnv && result.includes("drizzle-kit/api")) {
					result = result.replace(
						/require\s*\(\s*['"]drizzle-kit\/api['"]\s*\)/g,
						DRIZZLE_KIT_API_INLINE_STUB,
					);
				}

				// Patch RSC serializer: replace throw statements for values
				// that can't cross the server/client boundary with
				// `return undefined`. Uses AST (not regex) to handle all
				// throw forms including comma expressions.
				//
				// Next.js silently drops these in production. vinext doesn't
				// replicate that behavior, so every Payload page with field
				// configs (access functions, hooks, RegExps) would fail.
				if (
					isRscEnv &&
					id.includes("react-server-dom-webpack") &&
					result.includes("Client Component")
				) {
					const root = parse(Lang.JavaScript, result).root();
					const throws = root
						.findAll({ rule: { kind: "throw_statement" } })
						.filter((t) => t.text().includes("Client Component"));

					if (throws.length > 0) {
						const edits = throws.map((t) => t.replace("return undefined"));
						result = root.commitEdits(edits);
					}
				}

				if (result === code) {
					return;
				}
				return { code: result, map: null };
			},
		},

		// Intercept at runtime for non-pre-bundled imports.
		resolveId: {
			handler(source) {
				const envName = this.environment?.name;
				if (!envName || !serverEnvSet.has(envName)) {
					return;
				}
				return stubPaths[source] ?? undefined;
			},
		},
	};
}
