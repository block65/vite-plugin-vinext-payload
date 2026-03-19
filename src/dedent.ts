export function dedent(
	strings: TemplateStringsArray,
	...values: unknown[]
): string {
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
