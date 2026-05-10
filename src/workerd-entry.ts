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
 * The default export can take several shapes depending on how Rolldown
 * processes vinext's entry:
 *   - `function NAME(...)` declaration (bare function)
 *   - `var NAME = createAppRscHandler({...})` (call result — also a bare function)
 *   - `var NAME = { fetch: ... }` (already correct)
 *
 * We can't always tell statically which shape we're looking at, so we
 * emit a runtime check that wraps only when the original default is a
 * function value.
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
				const oldExport = exportMatch[0];
				const otherExports = exportMatch[2]; // e.g. ", generateStaticParamsMap"

				chunk.code = chunk.code.replace(
					oldExport,
					[
						`var __payload_worker_handler_orig = ${handlerName};`,
						`var __payload_worker_handler = typeof __payload_worker_handler_orig === "function"`,
						`  ? { async fetch(request, env, ctx) {`,
						`      try { return await __payload_worker_handler_orig(request, env, ctx); }`,
						`      catch (e) { console.error("[payload-worker]", e?.stack ?? e?.message ?? e); throw e; }`,
						`    } }`,
						`  : __payload_worker_handler_orig;`,
						`export { __payload_worker_handler as default${otherExports} }`,
					].join("\n"),
				);
			}
		},
	};
}
