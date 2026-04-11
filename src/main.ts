/**
 * vite-plugin-vinext-payload
 *
 * Vite plugin for running Payload CMS with vinext.
 *
 * @example
 * ```ts
 * import { payloadPlugin } from "vite-plugin-vinext-payload";
 *
 * export default defineConfig({
 *   plugins: [vinext(), payloadPlugin()],
 * });
 * ```
 */

import type { Plugin } from "vite";
import { cjsInterop } from "vite-plugin-cjs-interop";
import { payloadCjsInteropDeps } from "./cjs-interop-deps.ts";
import { payloadCjsTransform } from "./cjs-transform.ts";
import { payloadCliStubs } from "./cli-stubs.ts";
import { payloadHtmlDiffExportFix } from "./html-diff-export-fix.ts";
import { payloadNavComponentFix } from "./nav-component-fix.ts";
import { payloadNextNavigationFix } from "./next-navigation-fix.ts";
import { payloadOptimizeDeps } from "./optimize-deps.ts";
import { payloadRedirectFix } from "./redirect-fix.ts";
import { payloadRscExportFix } from "./rsc-export-fix.ts";
import { payloadRscRuntime } from "./rsc-runtime.ts";
import { payloadServerActionFix } from "./server-action-fix.ts";
import { payloadServerExternals } from "./server-externals.ts";
import { payloadUseClientBarrel } from "./use-client-barrel.ts";
import { payloadWorkerdCompat } from "./workerd-compat.ts";
import { payloadWorkerdEntry } from "./workerd-entry.ts";

export interface PayloadPluginOptions {
	/**
	 * Additional packages to externalize from server (SSR + RSC) bundling.
	 * Merged with the built-in list (esbuild, wrangler, miniflare, sharp).
	 */
	ssrExternal?: string[];

	/** Additional packages to exclude from optimizeDeps. */
	excludeFromOptimize?: string[];

	/** Additional CJS packages needing default export interop. */
	cjsInteropDeps?: string[];
}

/**
 * Payload CMS compatibility for Vite + vinext.
 *
 * Returns the full set of sub-plugins that make Payload run on Vite's
 * Environment API, plugin-rsc, and (optionally) workerd via
 * `@cloudflare/vite-plugin`.
 */
export function payloadPlugin(options: PayloadPluginOptions = {}): Plugin[] {
	const {
		ssrExternal,
		excludeFromOptimize = [],
		cjsInteropDeps: extraCjsInterop = [],
	} = options;

	return [
		payloadUseClientBarrel(),
		payloadServerExternals({ ssrExternal }),
		payloadWorkerdCompat(),
		payloadWorkerdEntry(),
		payloadHtmlDiffExportFix(),
		payloadOptimizeDeps(excludeFromOptimize),
		payloadCjsTransform(),
		payloadCliStubs(),
		payloadNavComponentFix(),
		payloadNextNavigationFix(),
		payloadRedirectFix(),
		payloadRscExportFix(),
		payloadRscRuntime(),
		payloadServerActionFix(),
		cjsInterop({
			dependencies: [...payloadCjsInteropDeps, ...extraCjsInterop],
		}),
	];
}
