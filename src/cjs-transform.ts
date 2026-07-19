import type { Plugin } from "vite";
import type { PatchDeclaration } from "./patch-manifest.ts";

// Pre-compiled regexes — these run on every node_modules file.
const REACT_EXCLUDE_RE =
	/node_modules\/(react|react-dom|react-server-dom-webpack|scheduler)(\/|$)/;
const TS_CJS_HELPER_RE = /\(this && this\.(__\w+)\)/g;

export const cjsTransformPatch = {
	id: "cjs-transform",
	kind: "transform",
	targets: [
		"any node_modules CJS/UMD file except react, react-dom, react-server-dom-webpack and scheduler",
	],
	reason:
		"files served raw via /@fs/ break in the browser (module.exports) and in Vite's strict-ESM module runner, where module-scope `this` is undefined for UMD wrappers and TS CJS helpers",
	removeWhen:
		"Vite converts CJS to ESM for files served outside optimizeDeps pre-bundling",
} satisfies PatchDeclaration;

export interface PayloadCjsTransformOptions {
	/**
	 * Names of Vite environments this transform applies to. When undefined
	 * (the default used by `vinextPayload`), the transform runs in every
	 * environment because Payload's admin UI lives in `client`. For headless
	 * worker setups via `vinextPayloadWorker`, pass the worker env name so
	 * the transform doesn't bleed into the parent app's `client` build and
	 * clobber named exports of unrelated CJS deps.
	 */
	envs?: string[];
}

/**
 * Single-pass CJS/UMD compatibility transform for node_modules.
 *
 * Handles three issues that break CJS/UMD code in the browser:
 *
 * 1. **module.exports wrapping** — Vite only converts CJS→ESM during
 *    optimizeDeps pre-bundling. Files served directly via `/@fs/` are
 *    sent as-is and browsers choke on `module.exports`. This wraps them
 *    with `var module/exports` + `export default`.
 *
 * 2. **UMD `this` wrappers** — `})(this, function(...) {` breaks in
 *    Vite's strict ESM module runner where `this` is `undefined` at
 *    module scope. Replaced with `globalThis`.
 *
 * 3. **TS CJS helpers** — `(this && this.__importDefault)` also breaks
 *    with `undefined` `this`. Replaced with `globalThis`.
 */
export function payloadCjsTransform(
	options: PayloadCjsTransformOptions = {},
): Plugin {
	const { envs } = options;
	return {
		name: "vite-plugin-payload:cjs-transform",

		...(envs && {
			applyToEnvironment(env) {
				return envs.includes(env.name);
			},
		}),

		transform: {
			handler(code, id) {
				if (!id.includes("node_modules")) {
					return;
				}

				// Never touch React/ReactDOM/react-server-dom-webpack —
				// Rolldown handles their CJS→ESM natively. Our wrapper would
				// shadow `module` and break their conditional require() pattern.
				if (REACT_EXCLUDE_RE.test(id)) {
					return;
				}

				// --- this → globalThis replacements (all environments) ---

				const withGlobalThis = code
					.replaceAll("})(this,", "})(globalThis,")
					.replace(TS_CJS_HELPER_RE, "(globalThis && globalThis.$1)");

				// --- module.exports wrapping (client only) ---

				const needsExportWrap =
					this.environment?.name === "client" &&
					!/\bexport\s+(default\b|{)/.test(withGlobalThis) &&
					withGlobalThis.includes("module.exports");

				const result = needsExportWrap
					? [
							`var module = { exports: {} };`,
							`var exports = module.exports;`,
							withGlobalThis,
							`export default module.exports;`,
						].join("\n")
					: withGlobalThis;

				if (result !== code) {
					return { code: result, map: null };
				}
			},
		},
	};
}
