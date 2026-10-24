/**
 * vite-plugin-vinext-payload
 *
 * Vite plugin for running Payload CMS with vinext.
 *
 * @example
 * ```ts
 * import vinextPayload from "vite-plugin-vinext-payload";
 *
 * export default defineConfig({
 *   plugins: [vinext(), vinextPayload()],
 * });
 * ```
 */

import type { Plugin } from "vite";
import { cjsTransformPatch, payloadCjsTransform } from "./cjs-transform.ts";
import { optimizeDepsPatch, payloadOptimizeDeps } from "./optimize-deps.ts";
import type { PatchDeclaration } from "./patch-manifest.ts";
import {
	payloadRscRuntime,
	fileTypeNodeEntryPatch,
	rscSerializerThrowsPatch,
	rscStubsPatch,
} from "./rsc-runtime.ts";
import {
	consoleCreateTaskPatch,
	importMetaUrlGuardPatch,
	nodeBuiltinShimsPatch,
	payloadWorkerdCompat,
	undiciFeatureDetectPatch,
} from "./workerd-compat.ts";

/**
 * Every rewrite this plugin makes to third-party code, as data. The README's
 * patch table is generated from this (`pnpm run docs:patches`) and a unit
 * test fails when the committed table drifts.
 */
export const PATCH_MANIFEST: readonly PatchDeclaration[] = [
	consoleCreateTaskPatch,
	undiciFeatureDetectPatch,
	importMetaUrlGuardPatch,
	nodeBuiltinShimsPatch,
	optimizeDepsPatch,
	cjsTransformPatch,
	rscStubsPatch,
	fileTypeNodeEntryPatch,
	rscSerializerThrowsPatch,
];

export interface VinextPayloadOptions {
	/** Additional packages to exclude from optimizeDeps. */
	excludeFromOptimize?: string[];
}

/**
 * Payload CMS compatibility for Vite + vinext.
 *
 * Returns the full set of sub-plugins that make Payload run on Vite's
 * Environment API, plugin-rsc, and (optionally) workerd via
 * `@cloudflare/vite-plugin`.
 */
export function vinextPayload(options: VinextPayloadOptions = {}): Plugin[] {
	const { excludeFromOptimize = [] } = options;

	return [
		payloadWorkerdCompat(),
		payloadOptimizeDeps(excludeFromOptimize),
		payloadCjsTransform(),
		payloadRscRuntime(),
	];
}

export interface VinextPayloadWorkerOptions {
	/**
	 * The Vite environment name for the auxiliary worker. Must match the
	 * `name` of the worker in `@cloudflare/vite-plugin`'s `auxiliaryWorkers`
	 * (or the top-level `viteEnvironment.name`).
	 */
	env: string;

	/** Additional packages to exclude from optimizeDeps. */
	excludeFromOptimize?: string[];
}

/**
 * Payload CMS compatibility for a headless Cloudflare auxiliary worker.
 *
 * Use this when running Payload only to expose its local API over RPC
 * (`WorkerEntrypoint`) — no admin UI, no vinext, no RSC pipeline. The
 * parent worker calls into this one via a Cloudflare service binding.
 *
 * Subset of `vinextPayload`: workerd polyfills, optimizeDeps excludes,
 * the `drizzle-kit/api` stub, `file-type` resolution, and CJS transforms.
 * The admin-UI / RSC fixes are intentionally excluded.
 *
 * The user's worker entry typically looks like:
 *
 * ```ts
 * import { WorkerEntrypoint } from "cloudflare:workers";
 * import { getPayload } from "payload";
 * import config from "./payload.config";
 *
 * export class CmsEntrypoint extends WorkerEntrypoint {
 *   async find(args) {
 *     const payload = await getPayload({ config });
 *     return payload.find(args);
 *   }
 * }
 * export default {
 *   fetch: () => new Response("cms worker", { status: 404 }),
 * };
 * ```
 */
export function vinextPayloadWorker(
	options: VinextPayloadWorkerOptions,
): Plugin[] {
	const { env, excludeFromOptimize = [] } = options;

	const serverEnvs = [env];

	return [
		// Enable the createTask polyfill against the worker's own env:
		// payload.config.ts commonly imports admin components at module
		// scope, dragging React in even when the worker only ever calls
		// the local API. Without the polyfill, workerd's console.createTask
		// throws on module init.
		payloadWorkerdCompat({ serverEnvs, reactEnv: env }),
		payloadOptimizeDeps({
			extraExcludes: excludeFromOptimize,
			envs: serverEnvs,
			clientEnv: false,
			rscEnv: false,
		}),
		payloadRscRuntime({ serverEnvs, rscEnv: false }),
		payloadCjsTransform({ envs: serverEnvs }),
	];
}

export default vinextPayload;

/** @deprecated Renamed to `vinextPayload`. */
export const payloadPlugin = vinextPayload;

/** @deprecated Renamed to `vinextPayloadWorker`. */
export const payloadWorkerPlugin = vinextPayloadWorker;

/** @deprecated Renamed to `VinextPayloadOptions`. */
export type PayloadPluginOptions = VinextPayloadOptions;

/** @deprecated Renamed to `VinextPayloadWorkerOptions`. */
export type PayloadWorkerPluginOptions = VinextPayloadWorkerOptions;
