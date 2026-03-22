/**
 * vite-plugin-vinext-payload
 *
 * Vite plugin for running Payload CMS with vinext.
 *
 * Use `payloadPlugin()` for the batteries-included experience, or
 * import individual plugins to compose your own setup.
 *
 * @example
 * ```ts
 * // Batteries-included
 * import { payloadPlugin } from "vite-plugin-vinext-payload";
 *
 * export default defineConfig({
 *   plugins: [vinext(), payloadPlugin()],
 * });
 * ```
 *
 * @example
 * ```ts
 * // À la carte
 * import { payloadConfigAlias, payloadCliStubs } from "vite-plugin-vinext-payload";
 *
 * export default defineConfig({
 *   plugins: [vinext(), payloadConfigAlias(), payloadCliStubs()],
 * });
 * ```
 */

import type { Plugin } from "vite";
import { cjsInterop } from "vite-plugin-cjs-interop";
import { payloadCjsInteropDeps } from "./cjs-interop-deps.ts";
import { payloadCjsTransform } from "./cjs-transform.ts";
import { payloadCliStubs } from "./cli-stubs.ts";
import {
	payloadConfigAlias,
	type PayloadConfigAliasOptions,
} from "./config-alias.ts";
import { payloadOptimizeDeps } from "./optimize-deps.ts";
import { payloadRscExportFix } from "./rsc-export-fix.ts";
import { payloadRscStubs } from "./rsc-stubs.ts";
import { payloadServerActionFix } from "./server-action-fix.ts";
import { payloadUseClientBarrel } from "./use-client-barrel.ts";

// Re-export individual plugins
export {
	payloadConfigAlias,
	type PayloadConfigAliasOptions,
} from "./config-alias.ts";
export { payloadOptimizeDeps } from "./optimize-deps.ts";
export { payloadCjsTransform } from "./cjs-transform.ts";
export { payloadCliStubs } from "./cli-stubs.ts";
export { payloadCjsInteropDeps } from "./cjs-interop-deps.ts";
export { payloadRscExportFix } from "./rsc-export-fix.ts";
export { payloadRscStubs } from "./rsc-stubs.ts";
export { RSC_STUBS } from "./payload-packages.ts";
export { payloadServerActionFix } from "./server-action-fix.ts";
export { payloadUseClientBarrel } from "./use-client-barrel.ts";

export interface PayloadPluginOptions extends PayloadConfigAliasOptions {
	/** Additional packages to exclude from optimizeDeps. */
	excludeFromOptimize?: string[];

	/** Additional CJS packages needing default export interop. */
	cjsInteropDeps?: string[];
}

/**
 * Batteries-included Payload CMS compatibility for Vite.
 *
 * Returns all sub-plugins with sensible defaults. For fine-grained
 * control, import the individual plugins instead.
 */
export function payloadPlugin(options: PayloadPluginOptions = {}): Plugin[] {
	const {
		ssrExternal,
		excludeFromOptimize = [],
		cjsInteropDeps: extraCjsInterop = [],
	} = options;

	return [
		payloadUseClientBarrel(),
		payloadConfigAlias({ ssrExternal }),
		payloadOptimizeDeps(excludeFromOptimize),
		payloadCjsTransform(),
		payloadCliStubs(),
		payloadRscExportFix(),
		payloadRscStubs(),
		payloadServerActionFix(),
		cjsInterop({
			dependencies: [...payloadCjsInteropDeps, ...extraCjsInterop],
		}),
	];
}
