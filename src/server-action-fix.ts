import { parse, Lang } from "@ast-grep/napi";
import type { Plugin } from "vite";
import type { PatchDeclaration } from "./patch-manifest.ts";

export const serverActionFixPatch = {
	id: "server-action-fix",
	kind: "transform",
	targets: ["vinext — server/app-browser-entry.js"],
	reason:
		"vinext's browser entry imports the navigation shim by relative path, bypassing the pre-bundled next/navigation alias: two module instances, split navigation state, and a runtime re-optimize on cold cache",
	removeWhen: "vinext uses the aliased next/navigation in its browser entry",
} satisfies PatchDeclaration;

/**
 * Rewrite the relative `../shims/navigation.js` import in vinext's browser
 * entry to `next/navigation`, so Vite serves the pre-bundled copy instead of
 * the raw shim alongside it.
 */
function rewriteNavigationImport(code: string): string {
	const root = parse(Lang.JavaScript, code).root();
	const navSource = root.find({
		rule: {
			kind: "string",
			// Anchored to the exact module. vinext 1.0 split the shim into
			// siblings — `navigation-context-state.js`, `navigation-errors.js`,
			// `navigation.js` — and an unanchored "shims/navigation" matches
			// all three. `root.find` returns the first in pre-order, so the
			// unanchored form rewrote `navigation-context-state.js` and left
			// the real target untouched. 0.1.3 had only the one module, which
			// is why this held until the 1.0 bump.
			regex: "shims/navigation\\.js",
			inside: { kind: "import_statement" },
		},
	});
	if (!navSource) {
		return code;
	}
	return root.commitEdits([navSource.replace('"next/navigation"')]);
}

export function payloadServerActionFix(): Plugin {
	return {
		name: "vite-plugin-payload:server-action-fix",
		enforce: "post",
		transform(code, id) {
			if (!id.includes("app-browser-entry")) {
				return;
			}
			const result = rewriteNavigationImport(code);
			if (result !== code) {
				return { code: result, map: null };
			}
		},
	};
}
