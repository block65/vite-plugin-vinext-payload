import { parse, Lang } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import type { Plugin } from "vite";
import { iife } from "./iife.ts";
import {
	patchApplies,
	recordPatch,
	type PatchDeclaration,
} from "./patch-manifest.ts";

export const serverActionFixPatch = {
	id: "server-action-fix",
	kind: "transform",
	targets: [
		"vinext — server/app-browser-entry.js",
		"vinext — server/app-browser-navigation-controller.js",
	],
	reason:
		"vinext applies the RSC tree of a data-returning server action before returning its data, resetting Payload form state and looping getFormState; its browser entry also imports the navigation shim by relative path, bypassing the pre-bundled next/navigation alias and forcing a runtime re-optimize",
	removeWhen:
		"vinext uses the aliased next/navigation in its browser entry and skips the visible commit for data-returning server actions",
	moduleId: /app-browser-(?:entry|navigation-controller)/,
} satisfies PatchDeclaration;

/**
 * Fixes issues in vinext's browser entry and navigation controller:
 *
 * 1. **Server action re-render** — for data-returning server actions (e.g.
 *    Payload's `getFormState` via `useActionState`), vinext applies the new
 *    RSC tree before returning the data. The re-render hands Payload's Form
 *    a fresh `initialState` → REPLACE_STATE resets pending field edits
 *    (e.g. dropdown changes revert on blur), and the next blur fires another
 *    `getFormState`, looping RSC requests.
 *
 *    - vinext ≤0.0.46: the render-then-check-returnValue happens directly
 *      in `app-browser-entry`. Fix: move render() after the returnValue
 *      check.
 *    - vinext 0.0.47–0.0.49: `commitSameUrlNavigatePayload` moved into
 *      `app-browser-navigation-controller` and called
 *      `dispatchApprovedVisibleCommit` unconditionally before returning the
 *      action's data.
 *    - vinext 0.0.50–0.0.55: same site, but the call was renamed to
 *      `dispatchSynchronousVisibleCommit` (a thinner sync wrapper around the
 *      approved-commit applier), still a one-line `if ($COND) dispatch(…)`.
 *      Fix: gate the dispatch on `!returnValue`.
 *    - vinext ≥0.1.0: the dispatch moved into a block body
 *      (`if (latestApproval.approvedCommit) { dispatch(…); syncHistory(…); }`
 *      with an `else` branch), so the one-line gate no longer matches. Gating
 *      the outer `if` would wrongly trip the `else`, so wrap just the bare
 *      dispatch call as `if (!returnValue) dispatch(…)`.
 *
 * 2. **Optimizer reload on cold start** — the browser entry imports vinext's
 *    navigation shim via a relative path (`../shims/navigation.js`), bypassing
 *    the pre-bundled `next/navigation` alias. Vite discovers the raw module
 *    at runtime → re-optimizes → full page reload. Also causes duplicate React
 *    instances (raw vs pre-bundled) → "Invalid hook call" errors.
 *    Fix: rewrite the relative import to `next/navigation`.
 *
 * Uses ast-grep for structural AST matching.
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

// vinext ≤0.0.32: reactRoot.render($ROOT)
// vinext ≥0.0.33: getReactRoot().render($ROOT)
const RENDER_PATTERNS = [
	"getReactRoot().render($ROOT)",
	"reactRoot.render($ROOT)",
];

/** Walk forward through siblings for the first node of the given kind. */
function findFollowingSibling(node: SgNode, kind: string): SgNode | undefined {
	const next = node.next();
	if (!next) {
		return undefined;
	}
	return next.kind() === kind ? next : findFollowingSibling(next, kind);
}

/**
 * Move the render() call after the returnValue check so data-returning
 * server actions (like getFormState) don't trigger a re-render that
 * resets Payload's form state.
 */
function moveRenderAfterReturnValue(code: string): string | null {
	const root = parse(Lang.JavaScript, code).root();

	const match = iife(() => {
		for (const pattern of RENDER_PATTERNS) {
			const ifStmt = root.find({
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
				return { ifStmt, pattern };
			}
		}
		return undefined;
	});

	if (!match) {
		return null;
	}

	const { ifStmt, pattern: matchedPattern } = match;

	const parentBlock = ifStmt.parent();
	if (!parentBlock) {
		return null;
	}

	const renderStmt = parentBlock.find(`${matchedPattern};`);
	if (!renderStmt) {
		return null;
	}

	// `return;` or `return undefined;` after the returnValue if-block
	const returnStmt = findFollowingSibling(ifStmt, "return_statement");
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

// Gate the unconditional dispatch in commitSameUrlNavigatePayload on
// !returnValue so data-returning server actions don't re-apply the RSC tree
// (which would reset Payload's form). vinext 0.0.47–0.0.49 called
// `dispatchApprovedVisibleCommit`; 0.0.50 renamed it to
// `dispatchSynchronousVisibleCommit`. Match either.
const DISPATCH_NAMES = [
	"dispatchSynchronousVisibleCommit",
	"dispatchApprovedVisibleCommit",
];

const INSIDE_COMMIT = {
	kind: "function_declaration",
	has: { kind: "identifier", regex: "^commitSameUrlNavigatePayload$" },
	stopBy: "end",
} as const;

function gateDispatchOnReturnValue(code: string): string | null {
	const root = parse(Lang.JavaScript, code).root();

	// vinext 0.0.47–0.0.55: a one-line `if ($COND) dispatchX(...)`. AND
	// `!returnValue` onto $COND. This branch also serves as the idempotency
	// guard for the block form below, whose output `if (!returnValue) dispatchX`
	// matches here with $COND === "!returnValue".
	for (const name of DISPATCH_NAMES) {
		const ifStmt = root.find({
			rule: {
				pattern: `if ($COND) ${name}($$$ARGS);`,
				inside: INSIDE_COMMIT,
			},
		});
		if (!ifStmt) {
			continue;
		}
		const cond = ifStmt.getMatch("COND");
		if (!cond) {
			continue;
		}
		const condText = cond.text();
		if (condText.includes("returnValue")) {
			return null;
		}
		return root.commitEdits([cond.replace(`${condText} && !returnValue`)]);
	}

	// vinext ≥0.1.0 moved the dispatch into a block body
	// (`if (latestApproval.approvedCommit) { dispatchX(...); syncHistory(...); }`
	// with an `else` branch), so the one-line gate no longer matches. Gating the
	// outer `if` would wrongly trip the `else` (a "discarded" revalidation
	// notice), so wrap just the bare dispatch call in `if (!returnValue) …`.
	for (const name of DISPATCH_NAMES) {
		const call = root.find({
			rule: {
				pattern: `${name}($$$ARGS)`,
				inside: INSIDE_COMMIT,
			},
		});
		if (!call) {
			continue;
		}
		return root.commitEdits([call.replace(`if (!returnValue) ${call.text()}`)]);
	}
	return null;
}

export function payloadServerActionFix(): Plugin {
	return {
		name: "vite-plugin-payload:server-action-fix",
		enforce: "post",
		transform(code, id) {
			if (!patchApplies(serverActionFixPatch, id)) {
				return;
			}

			if (id.includes("app-browser-navigation-controller")) {
				if (!code.includes("commitSameUrlNavigatePayload")) {
					return;
				}
				const fixed = gateDispatchOnReturnValue(code);
				if (fixed && fixed !== code) {
					recordPatch(serverActionFixPatch, id);
					return { code: fixed, map: null };
				}
				return;
			}

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
				recordPatch(serverActionFixPatch, id);
				return { code: result, map: null };
			}
		},
	};
}
