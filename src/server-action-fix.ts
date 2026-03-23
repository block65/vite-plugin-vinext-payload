import { parse, Lang } from "@ast-grep/napi";
import type { Plugin } from "vite";

/**
 * Fixes two issues in vinext's browser entry (`app-browser-entry`):
 *
 * 1. **Server action re-render** — vinext calls render() on the React root
 *    before checking if the action returned a value. This causes Payload's
 *    Form to receive a new `initialState` → REPLACE_STATE resets the form.
 *    Fix: move render() after the `returnValue` check.
 *
 * 2. **Optimizer reload on cold start** — the browser entry imports vinext's
 *    navigation shim via a relative path (`../shims/navigation.js`), bypassing
 *    the pre-bundled `next/navigation` alias. Vite discovers the raw module
 *    at runtime → re-optimizes → full page reload. Also causes duplicate React
 *    instances (raw vs pre-bundled) → "Invalid hook call" errors.
 *    Fix: rewrite the relative import to `next/navigation`.
 *
 * Uses ast-grep for structural AST matching.
 *
 * Remove: when vinext uses the aliased `next/navigation` in its browser entry
 * and defers render for data-returning server actions.
 */
export function payloadServerActionFix(): Plugin {
	return {
		name: "vite-plugin-payload:server-action-fix",
		enforce: "post",
		transform(code, id) {
			// Match both virtual module (vinext ≤0.0.32: "virtual:vinext-app-browser-entry")
			// and compiled file (vinext ≥0.0.33: "vinext/dist/server/app-browser-entry.js")
			if (!id.includes("app-browser-entry")) {
				return;
			}

			// Quick bailout for unrelated modules
			if (!code.includes("returnValue")) {
				return;
			}

			// Fix 2: Rewrite relative navigation import to use the aliased
			// (and pre-bundled) `next/navigation`. Without this, Vite serves
			// the raw shim file alongside the pre-bundled version → duplicate
			// React → optimizer discovers a new dep → full page reload.
			let transformed = code;
			const rawRoot = parse(Lang.JavaScript, code).root();
			const navSource = rawRoot.find({
				rule: {
					kind: "string",
					regex: "shims/navigation",
					inside: { kind: "import_statement" },
				},
			});
			if (navSource) {
				const r = navSource.range();
				transformed =
					code.slice(0, r.start.index) +
					'"next/navigation"' +
					code.slice(r.end.index);
			}

			// Fix 1: Move render() after returnValue check
			const root = parse(Lang.JavaScript, transformed).root();

			// vinext ≤0.0.32: reactRoot.render($ROOT)
			// vinext ≥0.0.33: getReactRoot().render($ROOT)
			const renderPatterns = [
				"getReactRoot().render($ROOT)",
				"reactRoot.render($ROOT)",
			];

			let ifStmt = null;
			let matchedPattern: string | null = null;

			for (const pattern of renderPatterns) {
				ifStmt = root.find({
					rule: {
						kind: "if_statement",
						has: { pattern: "result.returnValue", stopBy: "end" },
						follows: {
							pattern: `${pattern};`,
							stopBy: "end",
						},
					},
				});
				if (ifStmt) {
					matchedPattern = pattern;
					break;
				}
			}

			if (!ifStmt || !matchedPattern) {
				// Even if the render pattern isn't found (already patched,
				// or vinext changed), return the import-rewritten code.
				if (transformed !== code) {
					return { code: transformed, map: null };
				}
				return;
			}

			const parentBlock = ifStmt.parent();
			if (!parentBlock) {
				if (transformed !== code) {
					return { code: transformed, map: null };
				}
				return;
			}

			const renderStmt = parentBlock.find(`${matchedPattern};`);
			if (!renderStmt) {
				if (transformed !== code) {
					return { code: transformed, map: null };
				}
				return;
			}

			// Find `return;` or `return undefined;` after the returnValue if-block
			let returnStmt = ifStmt.next();
			while (returnStmt) {
				if (returnStmt.kind() === "return_statement") {
					break;
				}
				returnStmt = returnStmt.next();
			}
			if (!returnStmt) {
				if (transformed !== code) {
					return { code: transformed, map: null };
				}
				return;
			}

			// Move the render call from before the if-block to just before
			// the return — so data-returning actions (getFormState) skip the
			// re-render that resets Payload's form state.
			const renderRange = renderStmt.range();
			const returnRange = returnStmt.range();

			const renderLineStart =
				transformed.lastIndexOf("\n", renderRange.start.index) + 1;
			const renderIndent = transformed.slice(
				renderLineStart,
				renderRange.start.index,
			);
			const afterRender = transformed.indexOf("\n", renderRange.end.index);
			const removeEnd =
				afterRender !== -1 ? afterRender + 1 : renderRange.end.index;

			const returnLineStart =
				transformed.lastIndexOf("\n", returnRange.start.index) + 1;

			const before = transformed.slice(0, renderLineStart);
			const middle = transformed.slice(removeEnd, returnLineStart);
			const after = transformed.slice(returnLineStart);

			const result =
				before + middle + renderIndent + renderStmt.text() + "\n" + after;

			return { code: result, map: null };
		},
	};
}
