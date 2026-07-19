/**
 * Unit tests for `vite-plugin-vinext-payload init`.
 * Uses a minimal mock project directory — no npm install, no network.
 */

import { join } from "node:path";
import { afterAll, assert, describe, expect, it } from "vitest";
import { init } from "../bin/init.ts";
import {
	createProjectHelpers,
	scaffoldMockProject,
	FIXTURES,
} from "./helpers.ts";

const TEST_DIR = join(import.meta.dirname, ".mock-project");
const { read, write, exists, cleanup } = createProjectHelpers(TEST_DIR);

async function runInit(dryRun = false) {
	const logs: string[] = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk: string | Uint8Array) => {
		logs.push(chunk.toString());
		return true;
	};
	try {
		await init({ cwd: TEST_DIR, dryRun });
	} finally {
		process.stdout.write = origWrite;
	}
	return logs.join("");
}

function scaffold(viteConfig?: string, options?: { wranglerConfig?: boolean }) {
	return scaffoldMockProject(TEST_DIR, viteConfig, options);
}

describe("init: file transforms", () => {
	afterAll(cleanup);

	it("creates serverFunction.ts from inline 'use server' in layout", async () => {
		await scaffold();
		await runInit();

		const sf = await read("src/app/(payload)/serverFunction.ts");
		expect(sf).toMatch(/^'use server'/);
		expect(sf).toContain("handleServerFunctions");
	});

	it("rewrites layout.tsx to import from serverFunction.js", async () => {
		await scaffold();
		await runInit();

		const layout = await read("src/app/(payload)/layout.tsx");
		expect(layout).toContain("from './serverFunction.js'");
		expect(layout).not.toMatch(/^\s*'use server'\s*;?\s*$/m);
	});

	it("adds normalizeParams to page.tsx", async () => {
		await scaffold();
		await runInit();

		const page = await read("src/app/(payload)/admin/[[...segments]]/page.tsx");
		expect(page).toContain("normalizeParams");
		// The empty-segments case drops the key rather than casting undefined.
		expect(page).toContain("const { segments, ...rest } = resolved");
		expect(page).not.toContain("as unknown as");
	});

	// Regression: the emitted normalizeParams once dereferenced
	// `resolved.segments.length` unguarded. Next.js omits the key entirely, so
	// every /admin request threw "Cannot read properties of undefined". The
	// unit suite passed throughout — it only checked that the function existed.
	// This runs the emitted logic instead of matching its text.
	it("emits a normalizeParams that survives an absent segments key", async () => {
		await scaffold();
		await runInit();

		const page = await read("src/app/(payload)/admin/[[...segments]]/page.tsx");
		// Anchored on the declaration that follows, so the inner `}` of the
		// if-block cannot terminate the capture early.
		const body = page.match(
			/const normalizeParams = async \([^)]*\) => \{\n([\s\S]*?)\n\s*\}\n\n\s*export const generateMetadata/,
		);
		assert(body?.[1], "could not locate the emitted normalizeParams body");

		// Rebuild the emitted function without its type annotation and run it.
		// ASI covers the un-semicoloned statements the template emits.
		const normalizeParams = new Function(
			"params",
			`return (async () => {\n${body[1]}\n})()`,
		) as (params: unknown) => Promise<Record<string, unknown>>;

		// Next.js shape: no segments key at all. This threw before the fix.
		await expect(normalizeParams({})).resolves.toEqual({});

		// vinext shape: empty array means the dashboard root, so the key is dropped.
		await expect(normalizeParams({ segments: [] })).resolves.toEqual({});

		// A real route must keep its segments untouched.
		await expect(
			normalizeParams({ segments: ["collections", "users"] }),
		).resolves.toEqual({ segments: ["collections", "users"] });
	});
});

describe("init: vite.config.ts styles", () => {
	afterAll(cleanup);

	it("handles single-line plugins array", async () => {
		await scaffold(FIXTURES.viteConfigSingleLine);
		await runInit();

		const config = await read("vite.config.ts");
		expect(config).toContain("vinext(), payloadPlugin()");
	});

	it("handles multi-line plugins array", async () => {
		await scaffold(FIXTURES.viteConfigMultiLine);
		await runInit();

		const config = await read("vite.config.ts");
		expect(config).toContain("    vinext(),\n    payloadPlugin(),");
	});

	it("handles vinext() with an options argument (1.0 cloudflare shape)", async () => {
		await scaffold(FIXTURES.viteConfigVinextArgs);
		await runInit();

		const config = await read("vite.config.ts");
		expect(config).toContain('from "vite-plugin-vinext-payload"');
		expect(config).toContain("    }),\n    payloadPlugin(),");
	});

	it("handles tabs and single quotes", async () => {
		await scaffold(FIXTURES.viteConfigTabs);
		await runInit();

		const config = await read("vite.config.ts");
		expect(config).toContain("from 'vite-plugin-vinext-payload'");
		expect(config).toContain("\t\tvinext(),\n\t\tpayloadPlugin(),");
	});
});

describe("init: idempotency", () => {
	afterAll(cleanup);

	it("reports 0 changes on second run", async () => {
		await scaffold();
		await runInit();
		const output = await runInit();
		expect(output).toContain("0 file(s) changed");
	});

	it("does not duplicate payloadPlugin on repeated runs", async () => {
		await scaffold();
		await runInit();
		await runInit();
		await runInit();

		const config = await read("vite.config.ts");
		const matches = config.match(/payloadPlugin/g) ?? [];
		expect(matches).toHaveLength(2); // import + call
	});
});

describe("init: edge cases", () => {
	afterAll(cleanup);

	it("skips when serverFunction.ts already exists", async () => {
		await scaffold();
		await write("src/app/(payload)/serverFunction.ts", "'use server'\n");

		const output = await runInit();
		expect(output).toContain("already exists");
	});

	it("skips vite.config.ts when payloadPlugin already present", async () => {
		await scaffold();
		await runInit();
		const output = await runInit();
		expect(output).toContain("payloadPlugin already present");
	});

	it("dry-run does not write files", async () => {
		await scaffold();
		await runInit(true);

		const config = await read("vite.config.ts");
		expect(config).toBe(FIXTURES.viteConfigSingleLine);
		expect(await exists("src/app/(payload)/serverFunction.ts")).toBe(false);
		const page = await read("src/app/(payload)/admin/[[...segments]]/page.tsx");
		expect(page).toBe(FIXTURES.originalPage);
	});
});

describe("init: cloudflare plugin", () => {
	afterAll(cleanup);

	it("adds cloudflare() when wrangler.jsonc exists", async () => {
		await scaffold(undefined, { wranglerConfig: true });
		await runInit();

		const config = await read("vite.config.ts");
		expect(config).toContain("@cloudflare/vite-plugin");
		expect(config).toContain("cloudflare(");
		expect(config).toContain("viteEnvironment");
	});

	it("adds @cloudflare/vite-plugin to devDependencies", async () => {
		await scaffold(undefined, { wranglerConfig: true });
		await runInit();

		const pkg = JSON.parse(await read("package.json"));
		expect(pkg.devDependencies["@cloudflare/vite-plugin"]).toBeDefined();
	});

	it("places cloudflare() before vinext()", async () => {
		await scaffold(undefined, { wranglerConfig: true });
		await runInit();

		const config = await read("vite.config.ts");
		expect(config.indexOf("cloudflare(")).toBeLessThan(
			config.indexOf("vinext()"),
		);
	});

	it("handles multi-line plugins array with wrangler config", async () => {
		await scaffold(FIXTURES.viteConfigMultiLine, { wranglerConfig: true });
		await runInit();

		const config = await read("vite.config.ts");
		expect(config).toContain("cloudflare(");
		expect(config).toContain("payloadPlugin()");
		expect(config).toContain("vinext()");
	});

	it("skips cloudflare() when already present", async () => {
		await scaffold(undefined, { wranglerConfig: true });
		await runInit();
		await runInit();

		const config = await read("vite.config.ts");
		const matches = config.match(/cloudflare\(/g) ?? [];
		expect(matches).toHaveLength(1);
	});

	it("does not add cloudflare() without wrangler config", async () => {
		await scaffold();
		await runInit();

		const config = await read("vite.config.ts");
		expect(config).not.toContain("@cloudflare/vite-plugin");
	});
});
