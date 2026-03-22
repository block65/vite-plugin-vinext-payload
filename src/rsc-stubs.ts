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

/**
 * Stubs and polyfills for the RSC environment running in workerd.
 *
 * - `file-type`: uses Node.js fs/streams — transitively imported by
 *   `@payloadcms/db-d1-sqlite` but never invoked during RSC rendering.
 *   Without the stub, the pre-bundled chunk contains a bare
 *   `import 'file-type'` that the workerd module runner can't resolve.
 *
 * - `drizzle-kit/api`: migration utilities from `@payloadcms/db-d1-sqlite`,
 *   not needed during RSC rendering. pnpm strict isolation prevents
 *   resolution during pre-bundling.
 *
 * - `console.createTask`: workerd polyfill throws instead of being a
 *   no-op, breaking React 19 dev mode's async stack trace support.
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

		// Patch console.createTask before React's CJS code evaluates.
		transform: {
			handler(code, id) {
				if (this.environment?.name !== "rsc") {
					return;
				}
				if (id.includes("react") && code.includes("console.createTask")) {
					return {
						code: CONSOLE_CREATE_TASK_POLYFILL + code,
						map: null,
					};
				}
			},
		},

		// Intercept at runtime for non-pre-bundled RSC imports.
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
