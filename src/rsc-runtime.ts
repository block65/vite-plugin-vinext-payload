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

// Build the stub path map from the curated list + static files
const stubPaths: Record<string, string> = Object.fromEntries(
	Object.keys(RSC_STUBS)
		.filter((pkg) => pkg in STUB_FILES)
		.map((pkg) => [pkg, STUB_FILES[pkg]]),
);

// Workerd's node:console polyfill defines console.createTask but throws
// "not implemented" when called. React 19 dev mode checks for its
// existence and calls it for async stack traces.
// Upstream: workerd should make createTask a no-op, not throw.
//
// This polyfill is prepended to RSC modules that reference createTask.
// ESM hoists imports before executing body statements, so the polyfill
// runs after imports resolve but before the module's __commonJS wrapper
// evaluates React's CJS code. It's idempotent — once patched, subsequent
// modules pass the try and skip the assignment.
const CONSOLE_CREATE_TASK_POLYFILL =
	"try{console.createTask('_')}catch(_e){console.createTask=function(){return{run:function(f){return f()}}}};\n";

/**
 * RSC environment runtime patches for workerd.
 *
 * Three things in one plugin — all colocated because they only apply to
 * the `rsc` environment running inside workerd:
 *
 * - **Stubs** for `file-type` and `drizzle-kit/api`. Both are transitively
 *   imported by `@payloadcms/db-d1-sqlite` but never invoked during RSC
 *   rendering. Without stubs, the pre-bundled chunk contains a bare
 *   `import 'file-type'` that the workerd module runner can't resolve;
 *   `drizzle-kit/api` is unresolvable under pnpm strict isolation.
 *
 * - **`console.createTask` polyfill** for workerd. Workerd's `node:console`
 *   polyfill defines `console.createTask` but throws "not implemented"
 *   when called. React 19 dev mode checks for its existence and calls it
 *   for async stack traces. We prepend an idempotent no-op patch to React
 *   modules that reference it.
 *
 * - **RSC serializer patch** that converts the "Client Component" throw
 *   in `react-server-dom-webpack` into `return undefined`. Next.js
 *   silently drops non-serializable values (functions, RegExps, etc.) at
 *   the server/client boundary in production. vinext doesn't replicate
 *   that behavior, so every Payload page with field configs (access
 *   functions, hooks, RegExps) would fail without this patch.
 */
export function payloadRscRuntime(): Plugin {
	return {
		name: "vite-plugin-payload:rsc-runtime",

		// Redirect stubs during RSC optimizeDeps pre-bundling so they're
		// inlined rather than left as bare external imports that workerd
		// can't resolve.
		configEnvironment(name) {
			if (name !== "rsc") {
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
								},
							],
						},
					} as Record<string, unknown>),
				},
			} satisfies EnvironmentOptions;
		},

		transform: {
			handler(code, id) {
				if (this.environment?.name !== "rsc") {
					return;
				}

				let result = code;

				// Patch console.createTask (workerd polyfill throws).
				if (id.includes("/react/") && result.includes("console.createTask")) {
					result = CONSOLE_CREATE_TASK_POLYFILL + result;
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

		// Intercept at runtime for non-pre-bundled RSC imports.
		resolveId: {
			handler(source) {
				if (this.environment?.name !== "rsc") {
					return;
				}
				return stubPaths[source] ?? undefined;
			},
		},
	};
}
