import { Lang, parse } from "@ast-grep/napi";
import type { Plugin } from "vite";

/**
 * Fix Node.js builtin resolution and runtime compatibility in
 * Workers/Cloudflare builds.
 *
 * Four problems, four fixes:
 *
 * 1. **resolveId fallback** — The @cloudflare/vite-plugin resolves
 *    `node:*` imports to unenv polyfills via a resolveId hook with a
 *    Rolldown filter. That filter may not fire for CJS `require()` calls,
 *    so we provide a filterless fallback that routes `node:*` to unenv.
 *
 * 2. **undici transform** — Rolldown's CJS→ESM interop converts
 *    `require('node:X')` inside arrow functions to `init_X()` which
 *    returns `void` instead of the module object. undici's
 *    `detectRuntimeFeatureByExportedProperty` crashes accessing a
 *    property on `undefined`. We wrap it in try-catch.
 *
 * 3. **import.meta.url guard** — Bundled modules in workerd asset
 *    chunks may have `import.meta.url` as `undefined`. Packages like
 *    payload use `fileURLToPath(import.meta.url)` at module scope to
 *    derive `__dirname`. We guard with a fallback URL so module
 *    initialization doesn't crash.
 *
 * 4. **Workers entry wrapper** — Rolldown may inline the vinext
 *    app-router-entry wrapper and export the RSC handler as a bare
 *    function instead of `{ fetch() {} }`. This happens because
 *    Rolldown doesn't fully respect `preserveEntrySignatures: "strict"`
 *    (set by @cloudflare/vite-plugin) on large bundles. Cloudflare
 *    Workers expects a module with a `fetch` method on the default
 *    export. We detect the bare function in `generateBundle` and
 *    re-wrap it.
 *    See: https://github.com/cloudflare/workers-sdk/issues/10213
 */
export function payloadNodeBuiltinFix(): Plugin {
	return {
		name: "vite-plugin-payload:node-builtin-fix",

		resolveId: {
			async handler(id, importer) {
				const envName = this.environment?.name;
				if (envName !== "ssr" && envName !== "rsc") {
					return null;
				}
				if (!id.startsWith("node:")) {
					return null;
				}
				const bare = id.slice(5);
				try {
					return await this.resolve(`unenv/node/${bare}`, importer, {
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

				let result = code;
				let modified = false;

				// --- undici: wrap detectRuntimeFeatureByExportedProperty ---
				// (node_modules only)
				//
				// The lazy loader calls require('node:X') which Rolldown
				// converts to init_X() — a void-returning ESM initializer.
				// Accessing a property on undefined throws a TypeError.
				// With try-catch, the detection returns false and undici
				// falls back to its no-op stub.
				if (
					id.includes("node_modules") &&
					id.includes("undici") &&
					id.includes("runtime-features")
				) {
					const root = parse(Lang.JavaScript, result).root();
					const func = root.find(
						"function detectRuntimeFeatureByExportedProperty($A, $B) { $$$ }",
					);
					if (func) {
						const body = func.field("body");
						if (body) {
							const r = body.range();
							// Wrap body in try-catch
							result =
								result.slice(0, r.start.index) +
								`{ try ${body.text()} catch { return false } }` +
								result.slice(r.end.index);
							modified = true;
						}
					}
				}

				// --- import.meta.url guards (all files) ---
				//
				// In workerd, bundled asset modules may have import.meta.url
				// as undefined. Guard common patterns with a fallback so
				// module init doesn't crash. The dummy URL produces "/" —
				// filesystem ops using this path will fail elsewhere, but
				// those code paths aren't hit in Workers.
				if (
					result.includes("fileURLToPath(import.meta.url)") ||
					result.includes("createRequire(import.meta.url)")
				) {
					const root = parse(Lang.JavaScript, result).root();
					const edits = [
						...root.findAll("fileURLToPath(import.meta.url)"),
						...root.findAll("createRequire(import.meta.url)"),
					].map((n) =>
						n.replace(
							n
								.text()
								.replace("import.meta.url", 'import.meta.url ?? "file:///"'),
						),
					);

					if (edits.length > 0) {
						result = root.commitEdits(edits);
						modified = true;
					}
				}

				if (modified) {
					return { code: result, map: null };
				}
				return null;
			},
		},

		// --- Workers entry wrapper ---
		//
		// Rolldown may inline vinext's app-router-entry wrapper and
		// export the RSC handler as a bare `async function` instead of
		// `{ fetch() {} }`. Cloudflare Workers requires the default
		// export to be an object with a `fetch` method.
		//
		// This is a regression of cloudflare/workers-sdk#10213 on
		// Vite 8 / Rolldown. The cloudflare plugin sets
		// `preserveEntrySignatures: "strict"` (PR #10544) but Rolldown
		// doesn't fully enforce it for this inlining case.
		//
		// We detect the bare function in the entry chunk and re-wrap it
		// in the `{ fetch }` object that Workers expects.
		//
		// References:
		//   - https://github.com/cloudflare/workers-sdk/issues/10213
		//   - https://github.com/cloudflare/workers-sdk/pull/10544
		//   - https://github.com/rolldown/rolldown/issues/3500
		//   - https://github.com/rolldown/rolldown/issues/6449
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
