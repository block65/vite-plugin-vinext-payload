import type { Plugin } from "vite";
import type { PatchDeclaration } from "./patch-manifest.ts";

export const workerdEntryPatch = {
	id: "workerd-entry",
	kind: "transform",
	targets: ["vinext — the built rsc entry chunk's default export"],
	reason:
		"on Vite 8/Rolldown the { fetch } wrapper of vinext's app-router-entry can be inlined to a bare function, and a Worker whose default export has no fetch method fails to start",
	upstreamIssues: [
		"https://github.com/cloudflare/workers-sdk/issues/10213",
		"https://github.com/cloudflare/workers-sdk/pull/10544",
		"https://github.com/rolldown/rolldown/issues/3500",
		"https://github.com/rolldown/rolldown/issues/6449",
	],
	removeWhen:
		"Rolldown enforces preserveEntrySignatures: 'strict' for this inlining case",
	// Verified purely defensive on vinext 1.0.0-beta.2: the wrapper applies
	// but passes the already-correct { fetch } object through untouched.
	defensive: true,
} satisfies PatchDeclaration;

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
 * Verified against a real cloudflare-target build on vinext 1.0.0-beta.2
 * (2026-07-18): the rewrite applies, and the default there is already a
 * `{ fetch }` object (`var Zl = Yl ?? {}`), so the wrapper passes it
 * through untouched. On that version the plugin is purely defensive —
 * removing it would not break the build.
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

				// `as default` need not be the first specifier (builds have
				// emitted `export{Gc as __assetPrefix,...,al as default,...}`),
				// so scan the whole list rather than anchoring to the brace.
				const exportMatch = chunk.code.match(/export\s*\{([^}]*)\}/);
				if (!exportMatch) {
					continue;
				}

				const specifiers = exportMatch[1].split(",");
				const defaultIndex = specifiers.findIndex((specifier) =>
					/^\s*\w+\s+as\s+default\s*$/.test(specifier),
				);
				if (defaultIndex === -1) {
					continue;
				}

				const handlerName = specifiers[defaultIndex]
					.trim()
					.split(/\s+as\s+/)[0];
				specifiers[defaultIndex] = "__payload_worker_handler as default";

				chunk.code = chunk.code.replace(
					exportMatch[0],
					[
						`var __payload_worker_handler_orig = ${handlerName};`,
						`var __payload_worker_handler = typeof __payload_worker_handler_orig === "function"`,
						`  ? { async fetch(request, env, ctx) {`,
						`      try { return await __payload_worker_handler_orig(request, env, ctx); }`,
						`      catch (e) { console.error("[payload-worker]", e?.stack ?? e?.message ?? e); throw e; }`,
						`    } }`,
						`  : __payload_worker_handler_orig;`,
						`export {${specifiers.join(",")}}`,
					].join("\n"),
				);
			}
		},
	};
}
