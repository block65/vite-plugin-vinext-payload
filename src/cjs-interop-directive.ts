import type { Plugin } from "vite";
import type { PatchDeclaration } from "./patch-manifest.ts";

export const cjsInteropDirectivePatch = {
	id: "cjs-interop-directive",
	kind: "transform",
	targets: ["vite-plugin-cjs-interop — the preamble it prepends to a module"],
	reason:
		"on Vite 8 the interop preamble is inserted at byte 0, above any 'use client' directive, which drops the directive out of the parser's prologue; @vitejs/plugin-rsc then reads the module as server code and evaluates a client component under the react-server condition",
	removeWhen:
		"vite-plugin-cjs-interop inserts its preamble after the directive prologue",
} satisfies PatchDeclaration;

// Directives only count ahead of the first statement; comments may precede
// them. `use server` matters as much as `use client` — both are prologue-only.
const LEADING_DIRECTIVE =
	/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*(["'])use (?:client|server)\1;?/;

/**
 * Move a directive the wrapped transform displaced back to the top.
 *
 * Returns undefined when the input carried no directive, or when the output
 * still leads with one — in both cases there is nothing to repair.
 */
function hoistLeadingDirective(
	input: string,
	output: string,
): string | undefined {
	const match = LEADING_DIRECTIVE.exec(input);

	if (!match || LEADING_DIRECTIVE.test(output)) {
		return;
	}

	const directive = match[0].trimStart();
	const at = output.indexOf(directive);

	return at === -1
		? `${directive}\n${output}`
		: `${directive}\n${output.slice(0, at)}${output.slice(at + directive.length)}`;
}

/**
 * Wrap a plugin so its `transform` cannot displace a module's directive
 * prologue.
 *
 * `vite-plugin-cjs-interop` runs at `enforce: "pre"` and prepends its
 * generated destructuring at position 0. Any `'use client'` module that
 * imports one of the interop dependencies therefore reaches
 * `@vitejs/plugin-rsc` with its directive buried mid-body, where
 * `hasDirective` cannot see it — and the module is executed on the server
 * instead of becoming a client reference.
 */
export function preservingDirectives(plugin: Plugin): Plugin {
	const hook = plugin.transform;

	if (typeof hook !== "object" || typeof hook.handler !== "function") {
		return plugin;
	}

	const { handler, ...rest } = hook;

	return {
		...plugin,
		transform: {
			...rest,
			async handler(code, id, options) {
				const result = await handler.call(this, code, id, options);

				// The object form can still carry a non-string `code` (Rolldown's
				// magic-string) or none at all; neither is ours to rewrite.
				if (
					typeof result !== "object" ||
					result === null ||
					typeof result.code !== "string"
				) {
					return result;
				}

				const hoisted = hoistLeadingDirective(code, result.code);

				return hoisted === undefined ? result : { ...result, code: hoisted };
			},
		},
	};
}
