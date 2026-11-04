/**
 * The patch manifest is the plugin's public disclosure of what it rewrites.
 * These tests hold the two properties that make it trustworthy: the data is
 * well-formed, and the docs/internals.md table cannot drift from it
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
	PATCH_TABLE_BEGIN,
	PATCH_TABLE_END,
	renderPatchTable,
} from "../scripts/patch-table.ts";
import { PATCH_MANIFEST } from "../src/main.ts";

const DOC = path.join(import.meta.dirname, "..", "docs", "internals.md");

// oxfmt pads markdown table columns, so compare parsed cells rather than
// bytes — content drift fails, formatting drift does not
function cells(table: string) {
	return table
		.split("\n")
		.filter((line) => !/^\|[\s|:-]+\|$/.test(line))
		.map((line) => line.split("|").map((cell) => cell.trim()));
}

describe("patch manifest", () => {
	test("declares every patch exactly once, with the fields the table needs", () => {
		const ids = PATCH_MANIFEST.map((declaration) => declaration.id);

		expect(new Set(ids).size).toBe(ids.length);

		for (const declaration of PATCH_MANIFEST) {
			expect(declaration.id).toMatch(/^[a-z][a-z0-9-]+$/);
			expect(declaration.targets.length).toBeGreaterThan(0);
			expect(declaration.reason.length).toBeGreaterThan(20);
			expect(declaration.removeWhen.length).toBeGreaterThan(10);
		}
	});

	test("the committed docs table matches the manifest", async () => {
		const doc = await readFile(DOC, "utf-8");

		const begin = doc.indexOf(PATCH_TABLE_BEGIN);
		const end = doc.indexOf(PATCH_TABLE_END);
		expect(begin).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(begin);

		const committed = doc.slice(begin + PATCH_TABLE_BEGIN.length, end).trim();

		expect(cells(committed)).toEqual(cells(renderPatchTable(PATCH_MANIFEST)));
	});
});
