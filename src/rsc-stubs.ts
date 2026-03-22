import { fileURLToPath } from "node:url";
import type { EnvironmentOptions, Plugin } from "vite";

const FILE_TYPE_STUB = fileURLToPath(
	new URL("./stubs/file-type.js", import.meta.url),
);
const DRIZZLE_KIT_API_STUB = fileURLToPath(
	new URL("./stubs/drizzle-kit-api.js", import.meta.url),
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

// React 19 RSC serializer throws for values that can't cross the
// server/client boundary: functions, event handlers, class instances,
// RegExps, etc. Payload CMS field configs contain all of these (access
// functions, hooks, onInit, validation regexps). Next.js silently drops
// them — the value becomes `undefined` on the client. We patch each
// throw to return `undefined` instead, matching Next.js prod behavior.
//
// Regex uses [^;]*? before Error( to handle comma expressions like:
//   throw request = ..., Error("Functions are not valid...")
// The [^;] prevents matching across statement boundaries.
//
// Verified against react-server-dom-webpack@19.2.x pre-bundled output:
// 7 matches, valid ESM parse after replacement.
//
// Upstream: vinext should handle this, or React should offer a
// non-throwing serialization mode.
const RSC_SERIALIZER_ERRORS = [
	"Functions cannot be passed directly to Client Components",
	"Functions are not valid as a child of Client Components",
	"Only plain objects, and a few built-ins, can be passed to Client Components",
	"Event handlers cannot be passed to Client Component props",
	// Client reference proxy apply traps — "use client" export called as
	// function on server (e.g. Payload's useUploadHandlers via storage-r2).
	// React's proxy (react-server-dom-webpack):
	"Attempted to call",
	// @vitejs/plugin-rsc's proxy (dist/core/rsc.js):
	"Unexpectedly client reference export",
];

/**
 * Stubs and polyfills for the RSC environment running in workerd.
 *
 * - `file-type`: uses Node.js fs/streams — transitively imported by
 *   `@payloadcms/db-d1-sqlite` but never invoked during RSC rendering.
 *   Without the stub, the pre-bundled chunk contains a bare
 *   `import 'file-type'` that the workerd module runner can't resolve.
 *
 * - `console.createTask`: workerd polyfill throws instead of being a
 *   no-op, breaking React 19 dev mode's async stack trace support.
 *
 * - RSC serializer errors: React throws when unsupported values (functions,
 *   RegExps, class instances, event handlers) cross the RSC boundary.
 *   Payload CMS relies on Next.js silently dropping them. We patch the
 *   serializer to return `undefined` instead of throwing.
 */
export function payloadRscStubs(): Plugin {
	return {
		name: "vite-plugin-payload:rsc-stubs",

		// Redirect stubs during RSC optimizeDeps pre-bundling so they're
		// inlined rather than left as bare external imports that workerd
		// can't resolve. Provides both rolldownOptions (Vite 8+/Rolldown)
		// and esbuildOptions (Vite 6-7/esbuild) for compatibility.
		configEnvironment(name) {
			if (name !== "rsc") {
				return;
			}

			const stubs: Record<string, string> = {
				"file-type": FILE_TYPE_STUB,
				"drizzle-kit/api": DRIZZLE_KIT_API_STUB,
			};

			return {
				optimizeDeps: {
					// Vite 6-7 (esbuild) — deprecated in Vite 8 but still works
					esbuildOptions: {
						plugins: [
							{
								name: "payload-rsc-stubs",
								setup(build: {
									onResolve: (
										opts: { filter: RegExp },
										cb: () => { path: string },
									) => void;
								}) {
									for (const [pkg, stub] of Object.entries(stubs)) {
										build.onResolve(
											{
												filter: new RegExp(`^${pkg.replace("/", "\\/")}$`),
											},
											() => ({ path: stub }),
										);
									}
								},
							},
						],
					},
					// Vite 8+ (Rolldown) — added via spread to avoid type
					// errors on Vite versions that don't have the type yet
					...({
						rolldownOptions: {
							plugins: [
								{
									name: "payload-rsc-stubs",
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
				let modified = false;

				// Patch console.createTask — only in React modules (the only
				// code that calls console.createTask during module init).
				if (id.includes("react") && result.includes("console.createTask")) {
					result = CONSOLE_CREATE_TASK_POLYFILL + result;
					modified = true;
				}

				// Patch RSC serializer and client reference proxies.
				// Serializer errors only appear in react-server-dom-webpack.
				// Client ref proxy errors are generated by plugin-rsc's
				// transform and injected into ANY "use client" module
				// (e.g. @payloadcms/storage-r2), so that pattern must be
				// checked on all RSC modules.
				const isRscRuntime =
					id.includes("react-server-dom-webpack") || id.includes("plugin-rsc");

				for (const errorMsg of RSC_SERIALIZER_ERRORS) {
					const isClientRefError =
						errorMsg === "Unexpectedly client reference export";
					if (!isClientRefError && !isRscRuntime) {
						continue;
					}
					if (!result.includes(errorMsg)) {
						continue;
					}
					const escaped = errorMsg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					// Match throw Error("msg...") followed by ; or }
					// The ; case covers normal statements.
					// The } case covers arrow functions: () => { throw ... }
					const pattern = new RegExp(
						`throw\\s+[^;]*?Error\\(\\s*["'\`]${escaped}[\\s\\S]*?\\)\\s*[;}]`,
						"g",
					);
					// Client ref proxies: return a deep no-op proxy that
					// handles any property access or call without throwing.
					// Serializer errors: return undefined (value is dropped).
					const returnExpr = isClientRefError
						? "(function _np(){return new Proxy(function(){},{get:()=>_np(),apply:()=>_np()})})()"
						: "undefined";
					const replaced = result.replace(pattern, (match) =>
						match.endsWith("}")
							? `return ${returnExpr} }`
							: `return ${returnExpr};`,
					);
					if (replaced !== result) {
						result = replaced;
						modified = true;
					}
				}

				if (!modified) {
					return;
				}
				return { code: result, map: null };
			},
		},

		// Also intercept at runtime for any non-pre-bundled RSC imports
		// of file-type (e.g. from modules not covered by optimizeDeps).
		resolveId: {
			handler(source) {
				if (this.environment?.name !== "rsc") {
					return;
				}
				if (source === "file-type") return FILE_TYPE_STUB;
				if (source === "drizzle-kit/api") return DRIZZLE_KIT_API_STUB;
			},
		},
	};
}
