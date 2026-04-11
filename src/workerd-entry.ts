import type { Plugin } from "vite";

/**
 * Re-wraps the RSC entry chunk's default export in `{ fetch }` when
 * Rolldown inlines vinext's Workers handler wrapper into a bare function.
 *
 * Cloudflare Workers expects a module whose default export is an object
 * with a `fetch` method. vinext's `app-router-entry` provides exactly
 * that wrapper, but on Vite 8 / Rolldown the wrapper sometimes gets
 * inlined and the default export ends up as a bare `async function`
 * instead. The Worker fails to start because `default.fetch` is
 * `undefined`.
 *
 * The cloudflare plugin sets `preserveEntrySignatures: "strict"`
 * (workers-sdk#10544) but Rolldown doesn't fully enforce it for this
 * inlining case. This is a regression of workers-sdk#10213 on Vite 8.
 *
 * We detect a bare function default export in `generateBundle` and
 * replace it with the `{ fetch }` object that Workers expects.
 *
 * References:
 *   - https://github.com/cloudflare/workers-sdk/issues/10213
 *   - https://github.com/cloudflare/workers-sdk/pull/10544
 *   - https://github.com/rolldown/rolldown/issues/3500
 *   - https://github.com/rolldown/rolldown/issues/6449
 */
export function payloadWorkerdEntry(): Plugin {
	return {
		name: "vite-plugin-payload:workerd-entry",

		generateBundle(_, bundle) {
			const envName = this.environment?.name;
			if (envName !== "rsc") {
				return;
			}

			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== "chunk" || !chunk.isEntry) {
					continue;
				}

				// Match: export { handler as default ... }
				const exportMatch = chunk.code.match(
					/export\s*\{\s*(\w+)\s+as\s+default\b([^}]*)\}/,
				);
				if (!exportMatch) {
					continue;
				}

				const handlerName = exportMatch[1];

				// Only patch if the default export is a function declaration,
				// not already a `{ fetch }` wrapper object.
				const funcPattern = new RegExp(
					`(?:async\\s+)?function\\s+${handlerName}\\s*\\(`,
				);
				if (!funcPattern.test(chunk.code)) {
					continue;
				}

				const oldExport = exportMatch[0];
				const otherExports = exportMatch[2]; // e.g. ", generateStaticParamsMap"

				chunk.code = chunk.code.replace(
					oldExport,
					[
						`var __payload_worker_handler = { async fetch(request, env, ctx) {`,
						`  try { return await ${handlerName}(request, env, ctx); }`,
						`  catch (e) { console.error("[payload-worker]", e?.stack ?? e?.message ?? e); throw e; }`,
						`} };`,
						`export { __payload_worker_handler as default${otherExports} }`,
					].join("\n"),
				);
			}
		},
	};
}
