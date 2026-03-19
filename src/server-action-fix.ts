import { parse, Lang } from "@ast-grep/napi";
import type { Plugin } from "vite";

/**
 * Fixes vinext's server action re-render loop that causes infinite
 * form state cycles with Payload CMS.
 *
 * After every server action, vinext re-renders the full page tree by
 * calling `reactRoot.render(result.root)` before checking if the action
 * returned a value. This causes Payload's Form component to receive a
 * new `initialState` object reference → useEffect fires → REPLACE_STATE
 * resets the form → onChange fires another server action → infinite loop.
 *
 * The fix moves `reactRoot.render(result.root)` after the `returnValue`
 * check so the tree only re-renders for void mutation actions, not
 * data-returning ones like `getFormState`.
 *
 * Uses ast-grep for structural AST matching — resilient to whitespace,
 * comment, and formatting changes across vinext versions.
 *
 * This is a workaround until vinext fixes the issue upstream.
 * See: payloadcms/payload#15761
 */
export function payloadServerActionFix(): Plugin {
	return {
		name: "vite-plugin-payload:server-action-fix",
		enforce: "post",
		transform(code, id) {
			if (!id.includes("vinext-app-browser-entry")) {
				return;
			}

			const root = parse(Lang.JavaScript, code).root();

			// Find the broken pattern: an if-statement checking
			// `result.returnValue` that follows a `reactRoot.render()` call.
			// The `follows` rule with `stopBy: end` skips comment nodes
			// between the render call and the if-statement.
			const ifStmt = root.find({
				rule: {
					kind: "if_statement",
					has: { pattern: "result.returnValue", stopBy: "end" },
					follows: { pattern: "reactRoot.render($ROOT);", stopBy: "end" },
				},
			});

			if (!ifStmt) {
				return;
			}

			// Find the render statement within the same parent block
			const parentBlock = ifStmt.parent();
			if (!parentBlock) {
				return;
			}
			const renderStmt = parentBlock.find("reactRoot.render($ROOT);");
			if (!renderStmt) {
				return;
			}

			// Find `return undefined;` after the returnValue if-block
			let returnStmt = ifStmt.next();
			while (returnStmt) {
				if (
					returnStmt.kind() === "return_statement" &&
					returnStmt.text().includes("undefined")
				) {
					break;
				}
				returnStmt = returnStmt.next();
			}
			if (!returnStmt) {
				return;
			}

			// Remove the render statement from its current position and
			// reinsert it just before `return undefined;`
			const renderRange = renderStmt.range();
			const returnRange = returnStmt.range();

			const renderLineStart =
				code.lastIndexOf("\n", renderRange.start.index) + 1;
			const renderIndent = code.slice(renderLineStart, renderRange.start.index);
			const afterRender = code.indexOf("\n", renderRange.end.index);
			const removeEnd =
				afterRender !== -1 ? afterRender + 1 : renderRange.end.index;

			const returnLineStart =
				code.lastIndexOf("\n", returnRange.start.index) + 1;

			const before = code.slice(0, renderLineStart);
			const middle = code.slice(removeEnd, returnLineStart);
			const after = code.slice(returnLineStart);

			const transformed =
				before + middle + renderIndent + renderStmt.text() + "\n" + after;

			return { code: transformed, map: null };
		},
	};
}
