/**
 * Unit tests for `vite-plugin-vinext-payload init`.
 *
 * Uses a minimal mock project directory — no npm install, no network.
 * These run in milliseconds.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { init } from "../bin/init.ts";

const TEST_DIR = join(import.meta.dirname, ".mock-project");

function exists(path: string) {
	return access(path)
		.then(() => true)
		.catch(() => false);
}

async function write(relative: string, content: string) {
	const full = join(TEST_DIR, relative);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, content);
}

const read = (relative: string) => readFile(join(TEST_DIR, relative), "utf8");

async function cleanup() {
	if (await exists(TEST_DIR)) {
		await rm(TEST_DIR, { recursive: true, force: true });
	}
}

// ── Capture init output ────────────────────────────────────────────

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

// ── Fixtures ───────────────────────────────────────────────────────

const PACKAGE_JSON = JSON.stringify(
	{
		name: "test-project",
		dependencies: { payload: "^3.77.0" },
		devDependencies: { vinext: "^0.0.31" },
	},
	null,
	2,
);

const VITE_CONFIG_SINGLE_LINE = `import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vinext()],
});
`;

const VITE_CONFIG_MULTI_LINE = `import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext(),
  ],
});
`;

const VITE_CONFIG_TABS = `import { defineConfig } from 'vite';
import vinext from 'vinext';

export default defineConfig({
\tplugins: [
\t\tvinext(),
\t],
});
`;

const ORIGINAL_LAYOUT = `/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
/* DO NOT MODIFY IT BECAUSE IT COULD BE REWRITTEN AT ANY TIME. */
import config from '@payload-config'
import '@payloadcms/next/css'
import type { ServerFunctionClient } from 'payload'
import { handleServerFunctions, RootLayout } from '@payloadcms/next/layouts'
import React from 'react'

import { importMap } from './admin/importMap.js'
import './custom.scss'

type Args = {
  children: React.ReactNode
}

const serverFunction: ServerFunctionClient = async function (args) {
  'use server'
  return handleServerFunctions({
    ...args,
    config,
    importMap,
  })
}

const Layout = ({ children }: Args) => (
  <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
    {children}
  </RootLayout>
)

export default Layout
`;

const ORIGINAL_PAGE = `/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
/* DO NOT MODIFY IT BECAUSE IT COULD BE REWRITTEN AT ANY TIME. */
import type { Metadata } from 'next'

import config from '@payload-config'
import { RootPage, generatePageMetadata } from '@payloadcms/next/views'
import { importMap } from '../importMap'

type Args = {
  params: Promise<{
    segments: string[]
  }>
  searchParams: Promise<{
    [key: string]: string | string[]
  }>
}

export const generateMetadata = ({ params, searchParams }: Args): Promise<Metadata> =>
  generatePageMetadata({ config, params, searchParams })

const Page = ({ params, searchParams }: Args) =>
  RootPage({ config, params, searchParams, importMap })

export default Page
`;

const TSCONFIG = JSON.stringify(
	{
		compilerOptions: {
			paths: { "@payload-config": ["./src/payload.config.ts"] },
		},
	},
	null,
	2,
);

// ── Scaffold ───────────────────────────────────────────────────────

async function scaffold(viteConfig = VITE_CONFIG_SINGLE_LINE) {
	await cleanup();
	await mkdir(TEST_DIR, { recursive: true });
	await write("package.json", PACKAGE_JSON);
	await write("vite.config.ts", viteConfig);
	await write("tsconfig.json", TSCONFIG);
	await write("src/app/(payload)/layout.tsx", ORIGINAL_LAYOUT);
	await write("src/app/(payload)/admin/[[...segments]]/page.tsx", ORIGINAL_PAGE);
}

// ── Tests ──────────────────────────────────────────────────────────

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
		// The directive appears on its own line, not inside a comment
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
		await scaffold(VITE_CONFIG_SINGLE_LINE);
		await runInit();

		const config = await read("vite.config.ts");
		assert.ok(config.includes("vinext(), payloadPlugin()"), `unexpected format:\n${config}`);
	});

	it("handles multi-line plugins array", async () => {
		await scaffold(VITE_CONFIG_MULTI_LINE);
		await runInit();

		const config = await read("vite.config.ts");
		assert.ok(
			config.includes("    vinext(),\n    payloadPlugin(),"),
			`unexpected format:\n${config}`,
		);
	});

	it("handles tabs and single quotes", async () => {
		await scaffold(VITE_CONFIG_TABS);
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
		assert.equal(config, VITE_CONFIG_SINGLE_LINE);
		assert.ok(!(await exists(join(TEST_DIR, "src/app/(payload)/serverFunction.ts"))));
		const page = await read("src/app/(payload)/admin/[[...segments]]/page.tsx");
		assert.equal(page, ORIGINAL_PAGE);
	});
});
