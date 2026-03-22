import type { Plugin } from "vite";

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
 * Upstream: https://github.com/nicolo-ribaudo/vite-plugin-rsc
 * (transformWrapExport in server-action chunk, `output.move` to `input.length`)
 */
export function payloadRscExportFix(): Plugin {
	return {
		name: "vite-plugin-payload:rsc-export-fix",
		enforce: "post",
		transform: {
			handler(code, _id) {
				// Only fix in RSC environment
				if (this.environment?.name !== "rsc") {
					return;
				}

				// Fast bail — only relevant if there's a sourcemap comment
				// with an export stuck to it
				if (!code.includes("//# sourceMappingURL=")) {
					return;
				}

				// Match: //# sourceMappingURL=…export {  (on same line)
				const fixed = code.replace(
					/(\/\/# sourceMappingURL=[^\n]*?)(export\s)/g,
					"$1\n$2",
				);

				if (fixed === code) {
					return;
				}

				return { code: fixed, map: null };
			},
		},
	};
}
