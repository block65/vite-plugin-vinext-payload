import { parse, Lang } from "@ast-grep/napi";
import type { Plugin } from "vite";

/**
 * Fixes hydration mismatches in Payload components that render different
 * DOM element types based on `usePathname()` or `useParams()`.
 *
 * In vinext, these hooks return different values during SSR (server
 * request context) vs client hydration (`window.location` / empty
 * params), causing element-type mismatches that make React 19 discard
 * the entire server-rendered tree — dropping form state.
 *
 * Patched components:
 *
 * 1. **DefaultNavClient** (`@payloadcms/next Nav/index.client.js`)
 *    - `pathname === href` → `false`: always render `<Link>`, never `<div>`
 *    - `isActive && _jsx("div", { link-indicator })` → `false && ...`:
 *      skip the indicator div entirely
 *
 * 2. **DocumentTabLink** (`@payloadcms/next DocumentHeader/.../TabLink.js`)
 *    - `el: ... ? "link" : "div"` → `el: "link"`: always render as link
 *    - `disabled: isActive` → `disabled: false`: match the link rendering
 *
 * Uses ast-grep for structural matching — resilient to whitespace,
 * comment, and formatting changes across Payload versions.
 *
 * Remove: when vinext's navigation hooks use React context like Next.js,
 * or Payload removes the conditional element type rendering.
 */
export function payloadNavComponentFix(): Plugin {
	return {
		name: "vite-plugin-payload:nav-component-fix",
		transform(code, id) {
			if (!id.includes("@payloadcms")) {
				return;
			}

			// Dispatch to the right patcher based on file
			if (
				id.includes("Nav") &&
				id.includes("client") &&
				code.includes("pathname === href")
			) {
				return patchDefaultNavClient(code);
			}

			if (id.includes("TabLink") && code.includes("DocumentTabLink")) {
				return patchDocumentTabLink(code);
			}
		},
	};
}

function patchDefaultNavClient(
	code: string,
): { code: string; map: null } | undefined {
	const root = parse(Lang.JavaScript, code).root();
	const edits = [];

	// Fix 1: `pathname === href` → `false`
	const condition = root.find("pathname === href");
	if (condition) {
		edits.push(condition.replace("false /* patched: always render <Link> */"));
	}

	// Fix 2: `isActive && _jsx("div", ...)` with link-indicator → `false && ...`
	const indicatorExpr = root.find('isActive && _jsx("div", $PROPS)');
	if (indicatorExpr?.text().includes("link-indicator")) {
		const leftNode = indicatorExpr.find({
			rule: { kind: "identifier", regex: "^isActive$" },
		});
		if (leftNode) {
			edits.push(leftNode.replace("false /* patched: skip indicator */"));
		}
	}

	if (edits.length === 0) {
		return;
	}

	return { code: root.commitEdits(edits), map: null };
}

function patchDocumentTabLink(
	code: string,
): { code: string; map: null } | undefined {
	// The DocumentTabLink renders Button with conditional el/disabled/to
	// based on isActive. When useParams() returns {} during client hydration,
	// isActive differs from the server → element type mismatch.
	// Fix: always render el="link", disabled=false, to=hrefWithLocale.

	const root = parse(Lang.JavaScript, code).root();
	const edits = [];

	// Fix 1: Any ternary with "link"/"div" alternatives → always "link"
	const elTernary = root.find('$_ ? "link" : "div"');
	if (elTernary) {
		edits.push(
			elTernary.replace('"link" /* patched: always render as link */'),
		);
	}

	// Fix 2: disabled: isActive → disabled: false
	const disabledProp = root.find({
		rule: {
			kind: "pair",
			all: [
				{ has: { field: "key", regex: "^disabled$" } },
				{ has: { field: "value", regex: "^isActive$" } },
			],
		},
	});
	if (disabledProp) {
		for (const child of disabledProp.children()) {
			if (child.text() === "isActive" && child.kind() === "identifier") {
				edits.push(child.replace("false /* patched */"));
				break;
			}
		}
	}

	// Fix 3: Any ternary with hrefWithLocale/undefined → always hrefWithLocale
	const toTernary = root.find("$_ ? hrefWithLocale : undefined");
	if (toTernary) {
		edits.push(
			toTernary.replace("hrefWithLocale /* patched: always provide href */"),
		);
	}

	if (edits.length === 0) {
		return;
	}

	return { code: root.commitEdits(edits), map: null };
}
