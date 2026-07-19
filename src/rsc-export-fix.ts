import type { Plugin } from "vite";
import { recordPatch, type PatchDeclaration } from "./patch-manifest.ts";

export const rscExportFixPatch = {
	id: "rsc-export-fix",
	kind: "transform",
	targets: [
		"@vitejs/plugin-rsc — output of its CSS export transform, rsc environment only",
	],
	reason:
		"plugin-rsc relocates export statements to end-of-file with MagicString; when the source ends in a sourcemap comment without a trailing newline the export lands inside the comment and Rolldown cannot see it",
	upstreamIssues: ["https://github.com/vitejs/vite-plugin-react (plugin-rsc)"],
	removeWhen:
		"plugin-rsc's transformWrapExport emits a newline before relocated exports",
} satisfies PatchDeclaration;

/**
 * Fixes exports swallowed by `@vitejs/plugin-rsc`'s CSS export transform.
 *
 * Bug: `rsc:rsc-css-export-transform` uses MagicString `output.move()` to
 * relocate `export { name }` statements to the end of the file. When the
 * original source ends with a `//# sourceMappingURL=…` comment (no trailing
 * newline), the moved export statement is concatenated directly onto the
 * comment line, turning it into part of the comment. Rolldown then can't
 * see the export.
 *
 * Fix: run after the RSC transform and insert a newline before any
 * `export` keyword that appears after a `//` comment on the same line.
 *
 * Upstream: https://github.com/vitejs/vite-plugin-react (packages/plugin-rsc)
 * (transformWrapExport in server-action chunk, `output.move` to `input.length`)
 */
export function payloadRscExportFix(): Plugin {
	return {
		name: "vite-plugin-payload:rsc-export-fix",
		enforce: "post",
		transform: {
			handler(code, id) {
				if (this.environment?.name !== "rsc") {
					return;
				}

				// Fast bail — only relevant if there's a sourcemap comment
				// with an export stuck to it
				if (!code.includes("//# sourceMappingURL=")) {
					return;
				}

				// Match:
				//   //# sourceMappingURL=...export { ... }
				//   /*# sourceMappingURL=... */export { ... }
				// and inject a newline so export statements aren't swallowed.
				const fixed = code
					.replace(
						/(\/\/[#@]\s*sourceMappingURL=[^\r\n]*?)(export\s*(?:\{|\*|default\b))/g,
						"$1\n$2",
					)
					.replace(
						/(\/\*#\s*sourceMappingURL=[^*]*\*\/)(export\s*(?:\{|\*|default\b))/g,
						"$1\n$2",
					);

				if (fixed === code) {
					return;
				}
				recordPatch(rscExportFixPatch, id);
				return { code: fixed, map: null };
			},
		},
	};
}
