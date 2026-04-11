import { Lang, parse } from "@ast-grep/napi";
import type { Plugin } from "vite";

/**
 * Module-resolution and bundle-time compatibility fixes for code running
 * inside workerd (the Cloudflare Workers runtime).
 *
 * Three problems, three fixes — all needed before any module can
 * actually evaluate in workerd:
 *
 * 1. **`node:*` resolveId fallback** — `@cloudflare/vite-plugin` resolves
 *    `node:*` imports to unenv polyfills via a resolveId hook with a
 *    Rolldown filter. That filter may not fire for CJS `require()` calls,
 *    so we provide a filterless fallback that routes `node:*` to unenv.
 *
 * 2. **undici try-catch wrapper** — Rolldown's CJS→ESM interop converts
 *    `require('node:X')` inside arrow functions to `init_X()`, which
 *    returns `void` instead of the module object. undici's
 *    `detectRuntimeFeatureByExportedProperty` then crashes accessing a
 *    property on `undefined`. We wrap it in try-catch so detection
 *    returns false and undici falls back to its no-op stub.
 *
 * 3. **`import.meta.url` guard** — Bundled modules in workerd asset
 *    chunks may have `import.meta.url` as `undefined`. Packages like
 *    payload use `fileURLToPath(import.meta.url)` at module scope to
 *    derive `__dirname`, which crashes during module init. We rewrite
 *    `import.meta.url` to `import.meta.url ?? "file:///"` so module
 *    initialization survives.
 */
export function payloadWorkerdCompat(): Plugin {
	return {
		name: "vite-plugin-payload:workerd-compat",

		resolveId: {
			async handler(id, importer) {
				const envName = this.environment?.name;
				if (envName !== "ssr" && envName !== "rsc") {
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

				const needsUndici =
					id.includes("node_modules") &&
					id.includes("undici") &&
					id.includes("runtime-features");
				const needsMetaUrl =
					code.includes("fileURLToPath(import.meta.url)") ||
					code.includes("createRequire(import.meta.url)");

				if (!needsUndici && !needsMetaUrl) {
					return null;
				}

				let result = code;
				const root = parse(Lang.JavaScript, result).root();

				// undici: wrap detectRuntimeFeatureByExportedProperty in try-catch.
				// The lazy loader calls require('node:X') which Rolldown converts
				// to init_X() — a void-returning ESM initializer. Accessing a
				// property on undefined throws a TypeError. With try-catch, the
				// detection returns false and undici falls back to its no-op stub.
				if (needsUndici) {
					const func = root.find(
						"function detectRuntimeFeatureByExportedProperty($A, $B) { $$$ }",
					);
					if (func) {
						const body = func.field("body");
						if (body) {
							const r = body.range();
							result =
								result.slice(0, r.start.index) +
								`{ try ${body.text()} catch { return false } }` +
								result.slice(r.end.index);
						}
					}
				}

				// import.meta.url guards: in workerd, bundled asset modules may
				// have import.meta.url as undefined. Guard with a fallback so
				// module init doesn't crash.
				if (needsMetaUrl) {
					// Re-parse if undici transform modified the source
					const currentRoot =
						result !== code ? parse(Lang.JavaScript, result).root() : root;
					const edits = [
						...currentRoot.findAll("fileURLToPath(import.meta.url)"),
						...currentRoot.findAll("createRequire(import.meta.url)"),
					].map((n) =>
						n.replace(
							n
								.text()
								.replace("import.meta.url", 'import.meta.url ?? "file:///"'),
						),
					);

					if (edits.length > 0) {
						result = currentRoot.commitEdits(edits);
					}
				}

				if (result !== code) {
					return { code: result, map: null };
				}
				return null;
			},
		},
	};
}
