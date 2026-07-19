import { parse, Lang } from "@ast-grep/napi";
import type { Plugin } from "vite";
import { isTruthy } from "./iife.ts";
import type { PatchDeclaration } from "./patch-manifest.ts";

export const navComponentFixPatch = {
	id: "nav-component-fix",
	kind: "transform",
	targets: [
		"@payloadcms/next — Nav/index.client.js (DefaultNavClient)",
		"@payloadcms/next — DocumentHeader Tabs TabLink.js (DocumentTabLink)",
	],
	reason:
		"vinext's usePathname()/useParams() differ between SSR and client hydration, so these components render different element types and React 19 discards the server tree, dropping form state",
	removeWhen:
		"vinext's navigation hooks use React context like Next.js, or Payload removes the conditional element type rendering",
} satisfies PatchDeclaration;

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
 */
export function payloadNavComponentFix(): Plugin {
	return {
		name: "vite-plugin-payload:nav-component-fix",
		transform(code, id) {
			if (!id.includes("@payloadcms")) {
				return;
			}

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

	const condition = root.find("pathname === href");

	// Fix 2: `isActive && _jsx("div", ...)` with link-indicator → `false && ...`
	const indicatorExpr = root.find('isActive && _jsx("div", $PROPS)');
	const indicatorFlag = indicatorExpr?.text().includes("link-indicator")
		? indicatorExpr.find({ rule: { kind: "identifier", regex: "^isActive$" } })
		: undefined;

	const edits = [
		condition?.replace("false /* patched: always render <Link> */"),
		indicatorFlag?.replace("false /* patched: skip indicator */"),
	].filter(isTruthy);

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

	const elTernary = root.find('$_ ? "link" : "div"');

	const disabledProp = root.find({
		rule: {
			kind: "pair",
			all: [
				{ has: { field: "key", regex: "^disabled$" } },
				{ has: { field: "value", regex: "^isActive$" } },
			],
		},
	});
	const disabledFlag = disabledProp
		?.children()
		.find(
			(child) => child.text() === "isActive" && child.kind() === "identifier",
		);

	const toTernary = root.find("$_ ? hrefWithLocale : undefined");

	const edits = [
		elTernary?.replace('"link" /* patched: always render as link */'),
		disabledFlag?.replace("false /* patched */"),
		toTernary?.replace("hrefWithLocale /* patched: always provide href */"),
	].filter(isTruthy);

	if (edits.length === 0) {
		return;
	}

	return { code: root.commitEdits(edits), map: null };
}
