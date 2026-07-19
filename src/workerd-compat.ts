import { Lang, parse } from "@ast-grep/napi";
import type { EnvironmentOptions, Plugin } from "vite";
import { logger } from "./logger.ts";

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

/**
 * Wrap `detectRuntimeFeatureByExportedProperty` in a try-catch. Its lazy
 * loader calls `require('node:X')`, which Rolldown converts to a
 * void-returning ESM initializer — reading a property off the resulting
 * `undefined` throws a TypeError. Caught, detection returns false and undici
 * falls back to its no-op stub.
 */
function guardUndiciFeatureDetection(code: string): string {
	const root = parse(Lang.JavaScript, code).root();

	const func = root.find(
		"function detectRuntimeFeatureByExportedProperty($A, $B) { $$$ }",
	);
	const body = func?.field("body");
	if (!body) {
		return code;
	}

	const range = body.range();

	return (
		code.slice(0, range.start.index) +
		`{ try ${body.text()} catch { return false } }` +
		code.slice(range.end.index)
	);
}

/**
 * In workerd, bundled asset modules may see `import.meta.url` as undefined.
 * Add a fallback so module init doesn't crash.
 */
function guardImportMetaUrl(code: string): string {
	const root = parse(Lang.JavaScript, code).root();

	const edits = [
		...root.findAll("fileURLToPath(import.meta.url)"),
		...root.findAll("createRequire(import.meta.url)"),
	].map((n) =>
		n.replace(
			n.text().replace("import.meta.url", 'import.meta.url ?? "file:///"'),
		),
	);

	return edits.length > 0 ? root.commitEdits(edits) : code;
}

export interface PayloadWorkerdCompatOptions {
	/**
	 * Names of Vite environments running on workerd. These receive
	 * `node:*` → `unenv` resolution, undici runtime-feature shims, and
	 * `import.meta.url` guards. Defaults to `["ssr", "rsc"]`.
	 */
	serverEnvs?: string[];

	/**
	 * Name of the environment that loads React (used for the
	 * `console.createTask` polyfill). Pass `false` to disable the
	 * polyfill (workers that don't bundle React). Defaults to `"rsc"`.
	 */
	reactEnv?: string | false;
}

export function payloadWorkerdCompat(
	options: PayloadWorkerdCompatOptions = {},
): Plugin {
	const { serverEnvs = ["ssr", "rsc"], reactEnv = "rsc" } = options;
	const serverEnvSet = new Set(serverEnvs);

	return {
		name: "vite-plugin-payload:workerd-compat",

		configEnvironment(name) {
			if (reactEnv === false || name !== reactEnv) {
				return;
			}

			return {
				optimizeDeps: {
					rolldownOptions: {
						plugins: [
							{
								name: "payload-workerd-console-createtask",
								transform(code, id) {
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
				},
			} satisfies EnvironmentOptions;
		},

		resolveId: {
			async handler(id, importer) {
				const envName = this.environment?.name;
				if (!envName || !serverEnvSet.has(envName)) {
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
				} catch (err) {
					// unenv doesn't ship a shim for every node builtin. Fall through
					// to Vite's own resolution rather than failing the build.
					logger.trace(`no unenv shim for ${id}`, err);
					return null;
				}
			},
		},

		transform: {
			handler(code, id) {
				const envName = this.environment?.name;
				if (!envName || !serverEnvSet.has(envName)) {
					return null;
				}

				const needsCreateTask =
					envName === reactEnv && needsCreateTaskPolyfill(code, id);
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

				const withPolyfill = needsCreateTask
					? prependCreateTaskPolyfill(code)
					: code;

				const withUndici = needsUndici
					? guardUndiciFeatureDetection(withPolyfill)
					: withPolyfill;

				const result = needsMetaUrl
					? guardImportMetaUrl(withUndici)
					: withUndici;

				if (result !== code) {
					return { code: result, map: null };
				}
				return null;
			},
		},
	};
}
