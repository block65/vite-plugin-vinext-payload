import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import type { EnvironmentOptions, Plugin } from "vite";
import type { PatchDeclaration } from "./patch-manifest.ts";
import { RSC_STUBS } from "./payload-packages.ts";

export const rscStubsPatch = {
	id: "rsc-runtime-stubs",
	kind: "stub",
	targets: [
		"drizzle-kit/api → no-op stub, including inlined createRequire() calls",
	],
	reason:
		"drizzle-kit/api is transitively imported but never invoked during RSC rendering, and is loaded with createRequire(), which workerd cannot execute; per-entry notes live in payload-packages.ts (RSC_STUBS)",
	removeWhen: "workerd supports require(), or payload lazy-loads drizzle-kit",
} satisfies PatchDeclaration;

export const fileTypeNodeEntryPatch = {
	id: "file-type-node-entry",
	kind: "config",
	targets: ["file-type → file-type/node (server environments)"],
	reason:
		"server environments resolve file-type under the `default` export condition, which selects core.js; Payload imports fileTypeFromFile, which only the Node entry exports, and calls the detectors on every upload",
	removeWhen: "server environments resolve file-type with the `node` condition",
} satisfies PatchDeclaration;

export const rscSerializerThrowsPatch = {
	id: "rsc-serializer-throws",
	kind: "transform",
	targets: ["react-server-dom-webpack — 'Client Component' serializer throws"],
	reason:
		"the RSC serializer throws for values that cannot cross the server/client boundary (access functions, hooks, RegExps in Payload field configs); Next.js silently drops them in production, vinext does not, so every Payload page would fail",
	removeWhen:
		"vinext's RSC pipeline tolerates non-serializable config values the way Next.js does",
} satisfies PatchDeclaration;

// Static stub files — these must export the named exports that consumers
// expect. Dynamic empty stubs don't work because Rolldown checks for
// MISSING_EXPORT on named imports like { pushSQLiteSchema }.
const STUB_FILES: Record<string, string> = {
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

const stubPaths: Record<string, string> = Object.fromEntries(
	Object.keys(RSC_STUBS)
		.filter((pkg) => pkg in STUB_FILES)
		.map((pkg) => [pkg, STUB_FILES[pkg]]),
);

export interface PayloadRscRuntimeOptions {
	/**
	 * Names of server environments running on workerd. They get
	 * `drizzle-kit/api` stubbed (it comes in via `@payloadcms/db-d1-sqlite`
	 * and is never invoked in production) and `file-type` pointed at its
	 * Node entry, which Payload's upload checks need. Defaults to `["rsc"]`.
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

const FILE_TYPE_NODE_ENTRY = "file-type/node";

type Resolve = (
	source: string,
	importer: string | undefined,
	options?: { skipSelf?: boolean },
) => Promise<{ id: string } | null>;

// Resolved from the importer: Payload pins its own file-type version, and
// under pnpm only Payload can see it
function resolveFileTypeNodeEntry(
	resolve: Resolve,
	importer: string | undefined,
) {
	return resolve(FILE_TYPE_NODE_ENTRY, importer, { skipSelf: true });
}

// The optimizer keeps imports of an excluded package external, which would
// leave a bare `file-type/node` in the pre-bundled chunk that only Payload can
// resolve under pnpm; an absolute path is bundled into the chunk instead
function fileTypeNodeEntryPath(importer: string) {
	return createRequire(importer).resolve(FILE_TYPE_NODE_ENTRY);
}

function inlineDrizzleKitApi(code: string): string {
	return code.replace(
		/require\s*\(\s*['"]drizzle-kit\/api['"]\s*\)/g,
		DRIZZLE_KIT_API_INLINE_STUB,
	);
}

/**
 * Replace the RSC serializer's throws for values that can't cross the
 * server/client boundary with `return undefined`. AST rather than regex, so
 * every throw form is covered including comma expressions.
 *
 * Next.js silently drops these in production; vinext doesn't, so every Payload
 * page with field configs (access functions, hooks, RegExps) would fail.
 */
function dropClientComponentThrows(code: string): string {
	const root = parse(Lang.JavaScript, code).root();

	const edits = root
		.findAll({ rule: { kind: "throw_statement" } })
		.filter((node) => node.text().includes("Client Component"))
		.map((node) => node.replace("return undefined"));

	return edits.length > 0 ? root.commitEdits(edits) : code;
}

/**
 * Server-side workerd runtime patches.
 *
 * Three concerns:
 *
 * - **Stub** for `drizzle-kit/api` in any server env running on workerd
 *   (default `rsc`, extended for headless payload workers). It is imported
 *   via `@payloadcms/db-d1-sqlite` and not invoked at runtime.
 *
 * - **`file-type` resolution** to its Node entry in the same envs, so
 *   Payload's upload checks detect types from file contents.
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
		// `enforce: "pre"` is required for the `resolveId` hook below to win.
		// Without it, Vite's default resolver claims `file-type` first and
		// points it at the package's `core.js`, which doesn't export
		// `fileTypeFromFile`, so Rolldown errors with MISSING_EXPORT.
		enforce: "pre",

		// Redirect during optimizeDeps pre-bundling so the targets are
		// inlined rather than left as bare external imports that workerd
		// can't resolve.
		configEnvironment(name) {
			if (!serverEnvSet.has(name)) {
				return;
			}

			const stubs = stubPaths;

			return {
				optimizeDeps: {
					rolldownOptions: {
						plugins: [
							{
								name: "payload-rsc-runtime-stubs",
								resolveId(source, importer) {
									if (source === "file-type" && importer) {
										return fileTypeNodeEntryPath(importer);
									}
									return stubs[source] ?? null;
								},
								transform(code) {
									if (!code.includes("drizzle-kit/api")) {
										return null;
									}
									const replaced = inlineDrizzleKitApi(code);
									if (replaced === code) {
										return null;
									}
									return { code: replaced, map: null };
								},
							},
						],
					},
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

				// createRequire-based requires bypass resolveId — catch at
				// transform time for non-pre-bundled modules.
				const withStubbedDrizzle =
					isServerEnv && code.includes("drizzle-kit/api")
						? inlineDrizzleKitApi(code)
						: code;

				const result =
					isRscEnv &&
					id.includes("react-server-dom-webpack") &&
					withStubbedDrizzle.includes("Client Component")
						? dropClientComponentThrows(withStubbedDrizzle)
						: withStubbedDrizzle;

				if (result === code) {
					return;
				}
				return { code: result, map: null };
			},
		},

		// Intercept at runtime for non-pre-bundled imports.
		resolveId: {
			handler(source, importer) {
				const envName = this.environment?.name;
				if (!envName || !serverEnvSet.has(envName)) {
					return;
				}
				if (source === "file-type") {
					return resolveFileTypeNodeEntry(
						(...args) => this.resolve(...args),
						importer,
					);
				}
				return stubPaths[source] ?? undefined;
			},
		},
	};
}
