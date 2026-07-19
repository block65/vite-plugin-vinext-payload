/**
 * The patch manifest is the plugin's public disclosure of what it rewrites.
 * These tests hold the two properties that make it trustworthy: the data is
 * well-formed, and the README table cannot drift from it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	PATCH_TABLE_BEGIN,
	PATCH_TABLE_END,
	renderPatchTable,
} from "../scripts/patch-table.ts";
import { PATCH_MANIFEST } from "../src/main.ts";

const README = join(import.meta.dirname, "..", "README.md");

describe("patch manifest", () => {
	it("declares every patch exactly once, with the fields the table needs", () => {
		const ids = PATCH_MANIFEST.map((declaration) => declaration.id);

		expect(new Set(ids).size).toBe(ids.length);

		for (const declaration of PATCH_MANIFEST) {
			expect(declaration.id).toMatch(/^[a-z][a-z0-9-]+$/);
			expect(declaration.targets.length).toBeGreaterThan(0);
			expect(declaration.reason.length).toBeGreaterThan(20);
			expect(declaration.removeWhen.length).toBeGreaterThan(10);
		}
	});

	it("the committed README table matches the manifest", async () => {
		// oxfmt pads markdown table columns, so compare parsed cells rather
		// than bytes — content drift fails, formatting drift does not.
		const cells = (table: string) =>
			table
				.split("\n")
				.filter((line) => !/^\|[\s|:-]+\|$/.test(line))
				.map((line) => line.split("|").map((cell) => cell.trim()));

		const readme = await readFile(README, "utf8");

		const begin = readme.indexOf(PATCH_TABLE_BEGIN);
		const end = readme.indexOf(PATCH_TABLE_END);
		expect(begin).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(begin);

		const committed = readme
			.slice(begin + PATCH_TABLE_BEGIN.length, end)
			.trim();

		expect(cells(committed)).toEqual(cells(renderPatchTable(PATCH_MANIFEST)));
	});
});
