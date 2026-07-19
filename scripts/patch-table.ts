/**
 * Generates the README's build-time patch table from `PATCH_MANIFEST`. Run
 * via `pnpm run docs:patches`; `test/patch-manifest.test.ts` fails when the
 * committed table drifts from the manifest.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PATCH_MANIFEST } from "../src/main.ts";
import type { PatchDeclaration } from "../src/patch-manifest.ts";

export const PATCH_TABLE_BEGIN =
	"<!-- patch-table:begin — generated from PATCH_MANIFEST by scripts/patch-table.ts; edit the src/ declarations, then `pnpm run docs:patches` -->";
export const PATCH_TABLE_END = "<!-- patch-table:end -->";

const README = join(import.meta.dirname, "..", "README.md");

function cell(text: string): string {
	return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderPatchTable(
	manifest: readonly PatchDeclaration[],
): string {
	const rows = manifest.map((declaration) => {
		const why = [
			declaration.reason,
			...(declaration.defensive
				? ["Currently defensive: expected to rewrite nothing."]
				: []),
			...(declaration.upstreamIssues ?? []),
		].join("<br>");

		return `| \`${declaration.id}\` | ${declaration.kind} | ${cell(
			declaration.targets.join("<br>"),
		)} | ${cell(why)} | ${cell(declaration.removeWhen)} |`;
	});

	return [
		"| Patch | Kind | Rewrites | Why | Remove when |",
		"| --- | --- | --- | --- | --- |",
		...rows,
	].join("\n");
}

export async function updateReadme(): Promise<string> {
	const readme = await readFile(README, "utf8");

	const begin = readme.indexOf(PATCH_TABLE_BEGIN);
	const end = readme.indexOf(PATCH_TABLE_END);
	if (begin === -1 || end === -1 || end < begin) {
		throw new Error(
			`README.md is missing the ${PATCH_TABLE_BEGIN} / ${PATCH_TABLE_END} markers`,
		);
	}

	const updated =
		readme.slice(0, begin + PATCH_TABLE_BEGIN.length) +
		"\n\n" +
		renderPatchTable(PATCH_MANIFEST) +
		"\n\n" +
		readme.slice(end);

	await writeFile(README, updated);
	return updated;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await updateReadme();
}
