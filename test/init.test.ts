/**
 * Unit tests for `vite-plugin-vinext-payload init`.
 * Uses a minimal mock project directory — no npm install, no network.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { init } from "../bin/init.ts";
import { createProjectHelpers, scaffoldMockProject, FIXTURES } from "./helpers.ts";

const TEST_DIR = join(import.meta.dirname, ".mock-project");
const { read, write, exists, cleanup } = createProjectHelpers(TEST_DIR);

async function runInit(dryRun = false) {
	const logs: string[] = [];
	const origLog = console.log;
	console.log = (...args: unknown[]) => logs.push(args.join(" "));
	try {
		await init({ cwd: TEST_DIR, dryRun });
	} finally {
		console.log = origLog;
	}
	return logs.join("\n");
}

function scaffold(viteConfig?: string) {
	return scaffoldMockProject(TEST_DIR, viteConfig);
}

describe("init: file transforms", () => {
	after(cleanup);

	it("creates serverFunction.ts from inline 'use server' in layout", async () => {
		await scaffold();
		await runInit();

		const sf = await read("src/app/(payload)/serverFunction.ts");
		assert.ok(sf.startsWith("'use server'"));
		assert.ok(sf.includes("handleServerFunctions"));
	});

	it("rewrites layout.tsx to import from serverFunction.js", async () => {
		await scaffold();
		await runInit();

		const layout = await read("src/app/(payload)/layout.tsx");
		assert.ok(layout.includes("from './serverFunction.js'"));
		assert.ok(
			!layout.match(/^\s*'use server'\s*;?\s*$/m),
			"layout should not have inline 'use server' directive",
		);
	});

	it("adds normalizeParams to page.tsx", async () => {
		await scaffold();
		await runInit();

		const page = await read("src/app/(payload)/admin/[[...segments]]/page.tsx");
		assert.ok(page.includes("normalizeParams"));
		assert.ok(page.includes("segments: undefined"));
	});

	it("skips tsconfig when @payload-config already present", async () => {
		await scaffold();
		const output = await runInit();
		assert.ok(output.includes("@payload-config already present"));
	});
});

describe("init: vite.config.ts styles", () => {
	after(cleanup);

	it("handles single-line plugins array", async () => {
		await scaffold(FIXTURES.viteConfigSingleLine);
		await runInit();

		const config = await read("vite.config.ts");
		assert.ok(config.includes("vinext(), payloadPlugin()"), `unexpected format:\n${config}`);
	});

	it("handles multi-line plugins array", async () => {
		await scaffold(FIXTURES.viteConfigMultiLine);
		await runInit();

		const config = await read("vite.config.ts");
		assert.ok(
			config.includes("    vinext(),\n    payloadPlugin(),"),
			`unexpected format:\n${config}`,
		);
	});

	it("handles tabs and single quotes", async () => {
		await scaffold(FIXTURES.viteConfigTabs);
		await runInit();

		const config = await read("vite.config.ts");
		assert.ok(config.includes("from 'vite-plugin-vinext-payload'"), "should match single quote style");
		assert.ok(
			config.includes("\t\tvinext(),\n\t\tpayloadPlugin(),"),
			`unexpected format:\n${config}`,
		);
	});
});

describe("init: idempotency", () => {
	after(cleanup);

	it("reports 0 changes on second run", async () => {
		await scaffold();
		await runInit();
		const output = await runInit();
		assert.ok(output.includes("0 file(s) changed"));
	});

	it("does not duplicate payloadPlugin on repeated runs", async () => {
		await scaffold();
		await runInit();
		await runInit();
		await runInit();

		const config = await read("vite.config.ts");
		const matches = config.match(/payloadPlugin/g) ?? [];
		assert.equal(matches.length, 2, "should have exactly 2 mentions (import + call)");
	});
});

describe("init: edge cases", () => {
	after(cleanup);

	it("skips when serverFunction.ts already exists", async () => {
		await scaffold();
		await write("src/app/(payload)/serverFunction.ts", "'use server'\n");

		const output = await runInit();
		assert.ok(output.includes("already exists"));
	});

	it("skips vite.config.ts when payloadPlugin already present", async () => {
		await scaffold();
		await runInit();
		const output = await runInit();
		assert.ok(output.includes("payloadPlugin already present"));
	});

	it("dry-run does not write files", async () => {
		await scaffold();
		await runInit(true);

		const config = await read("vite.config.ts");
		assert.equal(config, FIXTURES.viteConfigSingleLine);
		assert.ok(!(await exists("src/app/(payload)/serverFunction.ts")));
		const page = await read("src/app/(payload)/admin/[[...segments]]/page.tsx");
		assert.equal(page, FIXTURES.originalPage);
	});
});
