/**
 * Unit tests for `payloadServerActionFix`.
 *
 * vinext's browser entry imports its navigation shim by relative path, so the
 * raw module is served next to the pre-bundled `next/navigation` copy — two
 * module instances with split state. The transform rewrites that one import
 * to the aliased specifier.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { payloadServerActionFix } from "../src/server-action-fix.ts";

const ENTRY_PATH = "/node_modules/vinext/dist/server/app-browser-entry.js";

function callTransform(plugin: Plugin, code: string, id: string) {
	const hook = plugin.transform;
	if (typeof hook !== "function") {
		throw new Error("expected plugin.transform to be a function");
	}
	return hook.call({} as never, code, id);
}

// Mirrors the import block of vinext 1.0's browser entry: the shim is split
// into sibling modules, and only `navigation.js` itself has an alias.
const ENTRY_FIXTURE = `
import { setNavigationContext } from "../shims/navigation-context-state.js";
import { isRedirectError } from "../shims/navigation-errors.js";
import { appRouterInstance, setClientParams, useRouter } from "../shims/navigation.js";
hydrateRoot(document, root);
`;

describe("payloadServerActionFix: browser entry navigation import", () => {
	const plugin = payloadServerActionFix();

	it("rewrites only the navigation.js import to the next/navigation alias", () => {
		const result = callTransform(plugin, ENTRY_FIXTURE, ENTRY_PATH);

		expect(result).toBeTruthy();
		const code = (result as { code: string }).code;
		expect(code).toContain(
			'import { appRouterInstance, setClientParams, useRouter } from "next/navigation";',
		);
		expect(code).not.toContain("shims/navigation.js");
		expect(code).toContain('"../shims/navigation-context-state.js"');
		expect(code).toContain('"../shims/navigation-errors.js"');
	});

	it("is idempotent on already-patched code", () => {
		const first = callTransform(plugin, ENTRY_FIXTURE, ENTRY_PATH) as
			| { code: string }
			| undefined;
		if (!first) {
			throw new Error("expected transform to return patched code");
		}

		const second = callTransform(plugin, first.code, ENTRY_PATH);

		expect(second).toBeFalsy();
	});

	it("does not touch unrelated files", () => {
		const result = callTransform(
			plugin,
			'import { x } from "../shims/navigation.js";',
			"/node_modules/some/other/module.js",
		);

		expect(result).toBeFalsy();
	});

	// Drift detector: the real installed browser entry must still carry the
	// relative import, and the transform must still find it.
	it("transforms the actual installed vinext app-browser-entry.js", () => {
		const realPath = join(
			import.meta.dirname,
			"..",
			"node_modules/vinext/dist/server/app-browser-entry.js",
		);
		const real = readFileSync(realPath, "utf8");
		expect(real).toContain('"../shims/navigation.js"');

		const result = callTransform(plugin, real, realPath);

		expect(result).toBeTruthy();
		const code = (result as { code: string }).code;
		expect(code).not.toContain('"../shims/navigation.js"');
		expect(code).toContain('from "next/navigation"');
	});
});
