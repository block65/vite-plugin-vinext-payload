import type { Plugin } from "vite";

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
export function payloadCjsTransform(): Plugin {
	return {
		name: "vite-plugin-payload:cjs-transform",

		transform: {
			handler(code, id) {
				if (!id.includes("node_modules")) {
					return;
				}

				// Never touch React/ReactDOM/react-server-dom-webpack —
				// Rolldown handles their CJS→ESM natively. Our wrapper would
				// shadow `module` and break their conditional require() pattern.
				if (
					/node_modules\/(react|react-dom|react-server-dom-webpack|scheduler)(\/|$)/.test(
						id,
					)
				) {
					return;
				}

				let result = code;

				// --- this → globalThis replacements (all environments) ---

				// UMD wrapper: `})(this, function` → `})(globalThis, function`
				if (result.includes("})(this,")) {
					result = result.replaceAll("})(this,", "})(globalThis,");
				}

				// TypeScript CJS helpers: `(this && this.__importX)` → globalThis
				if (result.includes("(this && this.")) {
					result = result.replace(
						/\(this && this\.(__\w+)\)/g,
						"(globalThis && globalThis.$1)",
					);
				}

				// --- module.exports wrapping (client only) ---

				const needsExportWrap =
					this.environment?.name === "client" &&
					!/\bexport\s+(default\b|{)/.test(result) &&
					result.includes("module.exports");

				if (needsExportWrap) {
					result = [
						`var module = { exports: {} };`,
						`var exports = module.exports;`,
						result,
						`export default module.exports;`,
					].join("\n");
				}

				if (result !== code) {
					return { code: result, map: null };
				}
			},
		},
	};
}
