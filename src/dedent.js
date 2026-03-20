// Plain JS — not TypeScript. Node 24 forbids type-stripping inside
// node_modules (smfh) and the CLI (bin/) imports this at runtime. Keeping it
// as .js avoids a build step for a 15-line function.

/**
 * Tagged template literal that strips leading indentation.
 *
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {string}
 */
export function dedent(strings, ...values) {
	const raw = String.raw(strings, ...values);
	const lines = raw.split("\n");
	if (lines[0]?.trim() === "") {
		lines.shift();
	}
	const indent = lines
		.filter((l) => l.trim())
		.reduce(
			(min, l) => Math.min(min, l.match(/^(\s*)/)?.[1].length ?? 0),
			Infinity,
		);
	return (
		lines
			.map((l) => l.slice(indent))
			.join("\n")
			.trimEnd() + "\n"
	);
}
