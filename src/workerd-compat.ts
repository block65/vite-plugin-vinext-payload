import { Lang, parse } from "@ast-grep/napi";
import type { EnvironmentOptions, Plugin } from "vite";

// Workerd's node:console polyfill defines console.createTask but throws
// "not implemented" when called. React 19 dev mode checks for its
// existence and calls it for async stack traces.
// Upstream: workerd should make createTask a no-op, not throw.
const CONSOLE_CREATE_TASK_POLYFILL =
	"try{console.createTask('_')}catch(_e){console.createTask=function(){return{run:function(f){return f()}}}};\n";

function prependCreateTaskPolyfill(code: string): string {
	return CONSOLE_CREATE_TASK_POLYFILL + code;
}

function needsCreateTaskPolyfill(code: string, id: string): boolean {
	return id.includes("react") && code.includes("console.createTask");
}

export function payloadWorkerdCompat(): Plugin {
	return {
		name: "vite-plugin-payload:workerd-compat",

		configEnvironment(name) {
			if (name !== "rsc") {
				return;
			}

			return {
				optimizeDeps: {
					...({
						rolldownOptions: {
							plugins: [
								{
									name: "payload-workerd-console-createtask",
									transform(code: string, id: string) {
										if (needsCreateTaskPolyfill(code, id)) {
											return {
												code: prependCreateTaskPolyfill(code),
												map: null,
											};
										}
									},
								},
							],
						},
					} as Record<string, unknown>),
				},
			} satisfies EnvironmentOptions;
		},

		resolveId: {
			async handler(id, importer) {
				const envName = this.environment?.name;
				if (envName !== "ssr" && envName !== "rsc") {
					return null;
				}
				if (!id.startsWith("node:")) {
					return null;
				}
				const moduleName = id.slice(5);
				try {
					return await this.resolve(`unenv/node/${moduleName}`, importer, {
						skipSelf: true,
					});
				} catch {
					return null;
				}
			},
		},

		transform: {
			handler(code, id) {
				const envName = this.environment?.name;
				if (envName !== "ssr" && envName !== "rsc") {
					return null;
				}

				const needsCreateTask =
					envName === "rsc" && needsCreateTaskPolyfill(code, id);
				const needsUndici =
					id.includes("node_modules") &&
					id.includes("undici") &&
					id.includes("runtime-features");
				const needsMetaUrl =
					code.includes("fileURLToPath(import.meta.url)") ||
					code.includes("createRequire(import.meta.url)");

				if (!needsCreateTask && !needsUndici && !needsMetaUrl) {
					return null;
				}

				let result = code;

				if (needsCreateTask) {
					result = prependCreateTaskPolyfill(result);
				}
				const root = parse(Lang.JavaScript, result).root();

				// undici: wrap detectRuntimeFeatureByExportedProperty in try-catch.
				// The lazy loader calls require('node:X') which Rolldown converts
				// to init_X() — a void-returning ESM initializer. Accessing a
				// property on undefined throws a TypeError. With try-catch, the
				// detection returns false and undici falls back to its no-op stub.
				if (needsUndici) {
					const func = root.find(
						"function detectRuntimeFeatureByExportedProperty($A, $B) { $$$ }",
					);
					if (func) {
						const body = func.field("body");
						if (body) {
							const r = body.range();
							result =
								result.slice(0, r.start.index) +
								`{ try ${body.text()} catch { return false } }` +
								result.slice(r.end.index);
						}
					}
				}

				// import.meta.url guards: in workerd, bundled asset modules may
				// have import.meta.url as undefined. Guard with a fallback so
				// module init doesn't crash.
				if (needsMetaUrl) {
					// Re-parse if undici transform modified the source
					const currentRoot =
						result !== code ? parse(Lang.JavaScript, result).root() : root;
					const edits = [
						...currentRoot.findAll("fileURLToPath(import.meta.url)"),
						...currentRoot.findAll("createRequire(import.meta.url)"),
					].map((n) =>
						n.replace(
							n
								.text()
								.replace("import.meta.url", 'import.meta.url ?? "file:///"'),
						),
					);

					if (edits.length > 0) {
						result = currentRoot.commitEdits(edits);
					}
				}

				if (result !== code) {
					return { code: result, map: null };
				}
				return null;
			},
		},
	};
}
