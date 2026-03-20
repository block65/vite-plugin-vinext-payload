import { execFile as execFileCb, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";

/** Known-good version matrix for testing. */
export const VERSIONS = {
	payload: "3.77.0",
	vinext: "0.0.31",
	vite: "7",
	pluginReact: "5",
	pluginRsc: "0.5",
} as const;

const execFile = promisify(execFileCb);

export function createProjectHelpers(testDir: string) {
	async function run(cmd: string, args: string[], cwd = testDir) {
		const { stdout } = await execFile(cmd, args, {
			cwd,
			timeout: 300_000,
			env: process.env,
		});
		return stdout;
	}

	const helpers = {
		run,
		npm: (args: string[]) => run("npm", args),
		npx: (args: string[]) => run("npx", args),
		read: (path: string) => readFile(join(testDir, path), "utf8"),
		write: async (path: string, content: string) => {
			await mkdir(dirname(join(testDir, path)), { recursive: true });
			await writeFile(join(testDir, path), content);
		},
		exists: (path: string) =>
			access(join(testDir, path))
				.then(() => true)
				.catch(() => false),
		cleanup: () => rm(testDir, { recursive: true, force: true }).catch(() => {}),
	};

	return helpers;
}

/** Wait for a spawned process stdout to match a pattern. */
export async function waitForOutput(proc: ChildProcess, pattern: RegExp, timeoutMs = 30_000) {
	assert.ok(proc.stdout, "process must have stdout");
	proc.stdout.setEncoding("utf8");

	const chunk = await proc.stdout.find(
		(data: string) => pattern.test(data),
		{ signal: AbortSignal.timeout(timeoutMs) },
	);

	const match = String(chunk ?? "").match(pattern);
	if (!match) {
		throw new Error(`Timed out waiting for ${pattern}`);
	}
	return match;
}

// ── Fixtures ───────────────────────────────────────────────────────

export const FIXTURES = {
	packageJson: JSON.stringify(
		{
			name: "test-project",
			dependencies: { payload: `^${VERSIONS.payload}` },
			devDependencies: { vinext: `^${VERSIONS.vinext}` },
		},
		null,
		2,
	),

	viteConfigSingleLine: `import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vinext()],
});
`,

	viteConfigMultiLine: `import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext(),
  ],
});
`,

	viteConfigTabs: `import { defineConfig } from 'vite';
import vinext from 'vinext';

export default defineConfig({
\tplugins: [
\t\tvinext(),
\t],
});
`,

	originalLayout: `/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
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
`,

	originalPage: `/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
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
`,

	tsconfig: JSON.stringify(
		{
			compilerOptions: {
				paths: { "@payload-config": ["./src/payload.config.ts"] },
			},
		},
		null,
		2,
	),
} as const;

/** Scaffold a minimal mock Payload project for unit tests. */
export async function scaffoldMockProject(
	testDir: string,
	viteConfig = FIXTURES.viteConfigSingleLine,
) {
	const { write, cleanup } = createProjectHelpers(testDir);
	await cleanup();
	await write("package.json", FIXTURES.packageJson);
	await write("vite.config.ts", viteConfig);
	await write("tsconfig.json", FIXTURES.tsconfig);
	await write("src/app/(payload)/layout.tsx", FIXTURES.originalLayout);
	await write("src/app/(payload)/admin/[[...segments]]/page.tsx", FIXTURES.originalPage);
}
