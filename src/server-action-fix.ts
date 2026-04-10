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

/**
 * Rewrite the relative `../shims/navigation.js` import to `next/navigation`
 * so Vite serves the pre-bundled version instead of the raw shim.
 */
function rewriteNavigationImport(code: string): string {
	const root = parse(Lang.JavaScript, code).root();
	const navSource = root.find({
		rule: {
			kind: "string",
			regex: "shims/navigation",
			inside: { kind: "import_statement" },
		},
	});
	if (!navSource) {
		return code;
	}
	return root.commitEdits([navSource.replace('"next/navigation"')]);
}

// vinext ≤0.0.32: reactRoot.render($ROOT)
// vinext ≥0.0.33: getReactRoot().render($ROOT)
const RENDER_PATTERNS = [
	"getReactRoot().render($ROOT)",
	"reactRoot.render($ROOT)",
];

/**
 * Move the render() call after the returnValue check so data-returning
 * server actions (like getFormState) don't trigger a re-render that
 * resets Payload's form state.
 */
function moveRenderAfterReturnValue(code: string): string | null {
	const root = parse(Lang.JavaScript, code).root();

	let ifStmt = null;
	let matchedPattern: string | null = null;

	for (const pattern of RENDER_PATTERNS) {
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
		return null;
	}

	const parentBlock = ifStmt.parent();
	if (!parentBlock) {
		return null;
	}

	const renderStmt = parentBlock.find(`${matchedPattern};`);
	if (!renderStmt) {
		return null;
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
		return null;
	}

	const renderRange = renderStmt.range();
	const returnRange = returnStmt.range();

	const renderLineStart = code.lastIndexOf("\n", renderRange.start.index) + 1;
	const renderIndent = code.slice(renderLineStart, renderRange.start.index);
	const afterRender = code.indexOf("\n", renderRange.end.index);
	const removeEnd =
		afterRender !== -1 ? afterRender + 1 : renderRange.end.index;

	const returnLineStart = code.lastIndexOf("\n", returnRange.start.index) + 1;

	const before = code.slice(0, renderLineStart);
	const middle = code.slice(removeEnd, returnLineStart);
	const after = code.slice(returnLineStart);

	return before + middle + renderIndent + renderStmt.text() + "\n" + after;
}

export function payloadServerActionFix(): Plugin {
	return {
		name: "vite-plugin-payload:server-action-fix",
		enforce: "post",
		transform(code, id) {
			if (!id.includes("app-browser-entry")) {
				return;
			}
			if (!code.includes("returnValue")) {
				return;
			}

			const withFixedImport = rewriteNavigationImport(code);
			const withFixedRender = moveRenderAfterReturnValue(withFixedImport);
			const result = withFixedRender ?? withFixedImport;

			if (result !== code) {
				return { code: result, map: null };
			}
		},
	};
}
