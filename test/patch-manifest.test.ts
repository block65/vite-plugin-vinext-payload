/**
 * The patch manifest is the plugin's public disclosure of what it rewrites.
 * These tests hold the three properties that make it trustworthy: the data
 * is well-formed, the README table cannot drift from it, and the runtime
 * enforcement (scope check, unapplied-patch warning) actually fires.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	PATCH_TABLE_BEGIN,
	PATCH_TABLE_END,
	renderPatchTable,
} from "../scripts/patch-table.ts";
import { PATCH_MANIFEST } from "../src/main.ts";
import {
	announcePatches,
	payloadPatchReport,
	recordPatch,
	warnUnappliedPatches,
	type PatchDeclaration,
} from "../src/patch-manifest.ts";

const README = join(import.meta.dirname, "..", "README.md");

function stderrSpy() {
	return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

function captured(spy: ReturnType<typeof stderrSpy>): string {
	return spy.mock.calls.map(([chunk]) => chunk.toString()).join("");
}

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

	it("recording a module outside the declared scope is surfaced as an error", () => {
		const declaration = {
			id: `scope-check-${crypto.randomUUID()}`,
			kind: "transform",
			targets: ["synthetic"],
			reason: "synthetic declaration for the scope enforcement path",
			removeWhen: "never — test fixture",
			moduleId: /only-this-module/,
		} satisfies PatchDeclaration;

		const write = stderrSpy();

		recordPatch(declaration, "/some/other/module.js");

		const output = captured(write);
		expect(output).toContain("outside its declared scope");
		expect(output).toContain(declaration.id);
	});

	it("announces once per process, then warns only for tracked transform patches that never applied", () => {
		const unappliedTransform = {
			id: `unapplied-${crypto.randomUUID()}`,
			kind: "transform",
			targets: ["synthetic"],
			reason: "synthetic transform that never records an application",
			removeWhen: "never — test fixture",
		} satisfies PatchDeclaration;

		const appliedTransform = {
			id: `applied-${crypto.randomUUID()}`,
			kind: "transform",
			targets: ["synthetic"],
			reason: "synthetic transform that does record an application",
			removeWhen: "never — test fixture",
		} satisfies PatchDeclaration;

		const configOnly = {
			id: `config-${crypto.randomUUID()}`,
			kind: "config",
			targets: ["synthetic"],
			reason: "synthetic config-only entry, exempt from the warning",
			removeWhen: "never — test fixture",
		} satisfies PatchDeclaration;

		const defensive = {
			id: `defensive-${crypto.randomUUID()}`,
			kind: "transform",
			targets: ["synthetic"],
			reason: "synthetic defensive entry, exempt from the warning",
			removeWhen: "never — test fixture",
			defensive: true,
		} satisfies PatchDeclaration;

		payloadPatchReport([
			unappliedTransform,
			appliedTransform,
			configOnly,
			defensive,
		]);
		recordPatch(appliedTransform, "/module.js");

		const write = stderrSpy();

		announcePatches();
		announcePatches();
		warnUnappliedPatches();
		warnUnappliedPatches();

		const output = captured(write);
		const summaryLines = output
			.split("\n")
			.filter((line) => line.includes("build-time patches"));

		expect(summaryLines).toHaveLength(1);
		expect(output).toContain(`patch ${unappliedTransform.id} matched nothing`);
		expect(output).not.toContain(`patch ${appliedTransform.id} matched`);
		expect(output).not.toContain(configOnly.id);
		expect(output).not.toContain(defensive.id);
	});
});
