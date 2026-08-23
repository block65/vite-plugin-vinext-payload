/**
 * Unit tests and drift detector for `preservingDirectives`.
 *
 * `vite-plugin-cjs-interop` runs at `enforce: "pre"` and, on Vite 8, prepends
 * its generated destructuring at position 0 — above any `'use client'`
 * directive. A directive is only a directive in the parser's prologue, so
 * `@vitejs/plugin-rsc` stops recognising the module as a client boundary and
 * executes a client component under the react-server condition. This is how a
 * Payload richText field crashed with `createContext is not a function`.
 */

import { parseAst } from "vite";
import { cjsInterop } from "vite-plugin-cjs-interop";
import { describe, expect, it } from "vitest";
import { payloadCjsInteropDeps } from "../src/cjs-interop-deps.ts";
import { preservingDirectives } from "../src/cjs-interop-directive.ts";

/** True when the parser puts a `use client` directive in the prologue. */
function parsesAsClientModule(code: string): boolean {
	return parseAst(code).body.some(
		(node) => "directive" in node && node.directive === "use client",
	);
}

function runTransform(
	plugin: ReturnType<typeof cjsInterop>,
	code: string,
	id: string,
) {
	const hook = plugin.transform;
	if (typeof hook !== "object" || typeof hook.handler !== "function") {
		throw new Error("expected cjsInterop to expose an object transform hook");
	}
	return hook.handler.call({} as never, code, id, { ssr: true } as never);
}

describe("preservingDirectives", () => {
	// `trustViteWithHoisting` is normally derived from the Vite version in a
	// config hook these tests do not run; on Vite 8 that derivation yields
	// true, which is the mode that moves the preamble to byte 0.
	const options = {
		dependencies: [...payloadCjsInteropDeps],
		trustViteWithHoisting: true,
	};

	it("keeps a client module parsing as a client module after interop rewriting", async () => {
		const source = `"use client";
import ObjectID from "bson-objectid";
export const id = () => ObjectID().toHexString();
`;
		expect(parsesAsClientModule(source)).toBe(true);

		const result = await runTransform(
			preservingDirectives(cjsInterop(options)),
			source,
			"/node_modules/some-pkg/dist/client.js",
		);

		const code = (result as { code: string }).code;
		expect(code).toContain("__cjsInterop");
		expect(parsesAsClientModule(code)).toBe(true);
	});

	// Drift detector: asserts the upstream defect still exists. When
	// vite-plugin-cjs-interop stops displacing the directive, this fails and
	// the wrapper can be deleted.
	it("still has a displacement to repair", async () => {
		const source = `"use client";
import ObjectID from "bson-objectid";
export const id = () => ObjectID().toHexString();
`;

		const result = await runTransform(
			cjsInterop(options),
			source,
			"/node_modules/some-pkg/dist/client.js",
		);

		expect(parsesAsClientModule((result as { code: string }).code)).toBe(false);
	});

	it("leaves a module without a directive alone", async () => {
		const source = `import ObjectID from "bson-objectid";
export const id = () => ObjectID().toHexString();
`;

		const wrapped = await runTransform(
			preservingDirectives(cjsInterop(options)),
			source,
			"/node_modules/some-pkg/dist/server.js",
		);
		const bare = await runTransform(
			cjsInterop(options),
			source,
			"/node_modules/some-pkg/dist/server.js",
		);

		expect((wrapped as { code: string }).code).toBe(
			(bare as { code: string }).code,
		);
	});
});
