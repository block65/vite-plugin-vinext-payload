/**
 * `vite-plugin-vinext-payload init`
 *
 * Applies Payload-specific fixes to a vinext project.
 * Run this after `vinext init` and `npm install -D vite-plugin-vinext-payload`.
 *
 * Transforms:
 * 1. Adds payloadPlugin() to vite.config.ts
 * 2. Extracts serverFunction from layout.tsx into a 'use server' module
 * 3. Adds normalizeParams to admin page.tsx
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { parse, Lang } from "@ast-grep/napi";
import type { PackageJson } from "type-fest";
import { dedent } from "../src/dedent.ts";

interface InitOptions {
	cwd: string;
	dryRun: boolean;
}

interface Result {
	file: string;
	action: "created" | "modified" | "skipped";
	reason?: string;
}

const PAYLOAD_DIR = "src/app/(payload)";
const ADMIN_DIR = `${PAYLOAD_DIR}/admin/[[...segments]]`;

const WRANGLER_CONFIG_FILES = [
	"wrangler.jsonc",
	"wrangler.json",
	"wrangler.toml",
];

async function findWranglerConfig(cwd: string): Promise<string | null> {
	const exists = await Promise.all(
		WRANGLER_CONFIG_FILES.map((file) =>
			access(join(cwd, file)).then(
				() => true,
				() => false,
			),
		),
	);
	const matchIndex = exists.findIndex(Boolean);
	return matchIndex === -1 ? null : WRANGLER_CONFIG_FILES[matchIndex];
}

async function hasWranglerConfig(cwd: string): Promise<boolean> {
	return (await findWranglerConfig(cwd)) !== null;
}

const SERVER_FUNCTION_TS = dedent`
  'use server'

  import config from '@payload-config'
  import type { ServerFunctionClient } from 'payload'
  import { handleServerFunctions } from '@payloadcms/next/layouts'

  import { importMap } from './admin/importMap.js'

  export const serverFunction: ServerFunctionClient = async function (args) {
    return handleServerFunctions({
      ...args,
      config,
      importMap,
    })
  }
`;

const LAYOUT_TSX = dedent`
  /* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
  /* Modified by vite-plugin-vinext-payload: extracted serverFunction to separate
     'use server' module for Vite RSC compatibility. */
  import config from '@payload-config'
  import '@payloadcms/next/css'
  import { RootLayout } from '@payloadcms/next/layouts'
  import React from 'react'

  import { importMap } from './admin/importMap.js'
  import './custom.scss'
  import { serverFunction } from './serverFunction.js'

  type Args = {
    children: React.ReactNode
  }

  const Layout = ({ children }: Args) => (
    <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
      {children}
    </RootLayout>
  )

  export default Layout
`;

const PAGE_TSX = dedent`
  /* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
  /* Modified by vite-plugin-vinext-payload: normalize empty segments for vinext. */
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

  // vinext passes segments=[] for /admin; Next.js passes undefined.
  // Normalize so Payload's dashboard route resolves correctly.
  const normalizeParams = async (params: Args['params']): Promise<Args['params']> => {
    const resolved = await params
    if (Array.isArray(resolved.segments) && resolved.segments.length === 0) {
      return Promise.resolve({ ...resolved, segments: undefined as unknown as string[] })
    }
    return params
  }

  export const generateMetadata = ({ params, searchParams }: Args): Promise<Metadata> =>
    generatePageMetadata({ config, params: normalizeParams(params), searchParams })

  const Page = ({ params, searchParams }: Args) =>
    RootPage({ config, params: normalizeParams(params), searchParams, importMap })

  export default Page
`;

async function readManifest(cwd: string): Promise<PackageJson> {
	const content = await tryRead(join(cwd, "package.json"));
	if (!content) {
		throw new InitError(
			"No package.json found. Run this from your project root.",
		);
	}
	try {
		return JSON.parse(content) as PackageJson;
	} catch {
		throw new InitError("package.json contains invalid JSON.");
	}
}

async function tryRead(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function maybeWrite(path: string, content: string, dryRun: boolean) {
	if (!dryRun) {
		await writeFile(path, content);
	}
}

/** Apply a template to a file if a sentinel string is absent. */
async function applyTemplate(
	cwd: string,
	relativePath: string,
	sentinel: string,
	template: string,
	dryRun: boolean,
): Promise<Result> {
	const file = join(cwd, relativePath);
	const content = await tryRead(file);

	if (!content) {
		return { file: relativePath, action: "skipped", reason: "not found" };
	}

	if (content.includes(sentinel)) {
		return {
			file: relativePath,
			action: "skipped",
			reason: `${sentinel} already present`,
		};
	}

	await maybeWrite(file, template, dryRun);
	return { file: relativePath, action: "modified" };
}

async function addPayloadPluginToViteConfig({
	cwd,
	dryRun,
}: InitOptions): Promise<Result[]> {
	const file = join(cwd, "vite.config.ts");
	const content = await tryRead(file);

	if (!content) {
		return [{ file: "vite.config.ts", action: "skipped", reason: "not found" }];
	}

	const results: Result[] = [];
	let updated = content;

	// --- Add payloadPlugin() ---
	if (!updated.includes("payloadPlugin")) {
		const root = parse(Lang.TypeScript, updated).root();

		const vinextCall = root.find({
			rule: {
				pattern: "vinext()",
				inside: { kind: "array", stopBy: "end" },
			},
		});

		if (!vinextCall) {
			results.push({
				file: "vite.config.ts",
				action: "skipped",
				reason: "could not find vinext() in plugins array",
			});
		} else {
			const allImports = root.findAll({ rule: { kind: "import_statement" } });
			const lastImport = allImports.at(-1);

			if (!lastImport) {
				results.push({
					file: "vite.config.ts",
					action: "skipped",
					reason: "no import statements found",
				});
			} else {
				const pluginsArray = vinextCall.parent();
				if (!pluginsArray || pluginsArray.kind() !== "array") {
					results.push({
						file: "vite.config.ts",
						action: "skipped",
						reason: "vinext() not inside an array",
					});
				} else {
					const lastImportEnd = lastImport.range().end.index;
					const quote = lastImport.text().includes("'") ? "'" : '"';
					const importLine = `\nimport { payloadPlugin } from ${quote}vite-plugin-vinext-payload${quote};`;

					const vinextRange = vinextCall.range();
					const vinextLineStart =
						updated.lastIndexOf("\n", vinextRange.start.index) + 1;
					const isSingleLine = !pluginsArray.text().includes("\n");

					const { pluginInsert, insertAt } = isSingleLine
						? {
								pluginInsert: ", payloadPlugin()",
								insertAt:
									updated[vinextRange.end.index] === ","
										? vinextRange.end.index + 1
										: vinextRange.end.index,
							}
						: (() => {
								const indent = updated.slice(
									vinextLineStart,
									vinextRange.start.index,
								);
								const hasComma = updated[vinextRange.end.index] === ",";
								return {
									pluginInsert:
										(hasComma ? "" : ",") + "\n" + indent + "payloadPlugin(),",
									insertAt: hasComma
										? vinextRange.end.index + 1
										: vinextRange.end.index,
								};
							})();

					updated =
						updated.slice(0, lastImportEnd) +
						importLine +
						updated.slice(lastImportEnd, insertAt) +
						pluginInsert +
						updated.slice(insertAt);

					results.push({ file: "vite.config.ts", action: "modified" });
				}
			}
		}
	} else {
		results.push({
			file: "vite.config.ts",
			action: "skipped",
			reason: "payloadPlugin already present",
		});
	}

	// --- Add cloudflare() for projects with wrangler config ---
	const needsCloudflare =
		(await hasWranglerConfig(cwd)) &&
		!updated.includes("@cloudflare/vite-plugin");

	if (needsCloudflare) {
		const root = parse(Lang.TypeScript, updated).root();

		const vinextCall = root.find({
			rule: {
				pattern: "vinext()",
				inside: { kind: "array", stopBy: "end" },
			},
		});

		if (vinextCall) {
			const allImports = root.findAll({
				rule: { kind: "import_statement" },
			});
			const lastImport = allImports.at(-1);

			if (lastImport) {
				const quote = lastImport.text().includes("'") ? "'" : '"';
				const importLine = `\nimport { cloudflare } from ${quote}@cloudflare/vite-plugin${quote};`;
				const lastImportEnd = lastImport.range().end.index;

				const pluginsArray = vinextCall.parent();
				const vinextRange = vinextCall.range();
				const isSingleLine =
					pluginsArray && !pluginsArray.text().includes("\n");

				const cfPlugin =
					'cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })';

				// Insert cloudflare() before vinext()
				const vinextLineStart =
					updated.lastIndexOf("\n", vinextRange.start.index) + 1;

				let cfInsert: string;
				let cfInsertAt: number;

				if (isSingleLine) {
					cfInsert = `${cfPlugin}, `;
					cfInsertAt = vinextRange.start.index;
				} else {
					const indent = updated.slice(
						vinextLineStart,
						vinextRange.start.index,
					);
					cfInsert = `${indent}${cfPlugin},\n`;
					cfInsertAt = vinextLineStart;
				}

				updated =
					updated.slice(0, lastImportEnd) +
					importLine +
					updated.slice(lastImportEnd, cfInsertAt) +
					cfInsert +
					updated.slice(cfInsertAt);

				results.push({
					file: "vite.config.ts",
					action: "modified",
					reason: "added cloudflare() for wrangler config",
				});
			}
		}
	}

	if (results.some((r) => r.action !== "skipped")) {
		await maybeWrite(file, updated, dryRun);
	}

	return results;
}

/**
 * Handles both serverFunction extraction and layout rewrite in one pass.
 * Avoids the race condition of reading/writing layout.tsx concurrently.
 */
async function fixServerFunction({
	cwd,
	dryRun,
}: InitOptions): Promise<Result[]> {
	const serverFnFile = join(cwd, PAYLOAD_DIR, "serverFunction.ts");
	const layoutFile = join(cwd, PAYLOAD_DIR, "layout.tsx");

	// Check if serverFunction.ts already exists
	const existingServerFn = await tryRead(serverFnFile);
	if (existingServerFn) {
		const layoutContent = await tryRead(layoutFile);
		if (!layoutContent || layoutContent.includes("serverFunction.js")) {
			return [
				{
					file: `${PAYLOAD_DIR}/serverFunction.ts`,
					action: "skipped",
					reason: "already exists",
				},
				{
					file: `${PAYLOAD_DIR}/layout.tsx`,
					action: "skipped",
					reason: "already imports serverFunction",
				},
			];
		}
		// serverFunction.ts exists but layout doesn't import it yet
		await maybeWrite(layoutFile, LAYOUT_TSX, dryRun);
		return [
			{
				file: `${PAYLOAD_DIR}/serverFunction.ts`,
				action: "skipped",
				reason: "already exists",
			},
			{ file: `${PAYLOAD_DIR}/layout.tsx`, action: "modified" },
		];
	}

	// serverFunction.ts doesn't exist — check if layout has inline 'use server'
	const layoutContent = await tryRead(layoutFile);
	if (!layoutContent) {
		return [
			{
				file: `${PAYLOAD_DIR}/serverFunction.ts`,
				action: "skipped",
				reason: "layout not found",
			},
			{
				file: `${PAYLOAD_DIR}/layout.tsx`,
				action: "skipped",
				reason: "not found",
			},
		];
	}

	if (!layoutContent.includes("'use server'")) {
		return [
			{
				file: `${PAYLOAD_DIR}/serverFunction.ts`,
				action: "skipped",
				reason: "no inline 'use server' found",
			},
			{
				file: `${PAYLOAD_DIR}/layout.tsx`,
				action: "skipped",
				reason: "no inline 'use server' found",
			},
		];
	}

	// Extract: create serverFunction.ts and rewrite layout.tsx
	await maybeWrite(serverFnFile, SERVER_FUNCTION_TS, dryRun);
	await maybeWrite(layoutFile, LAYOUT_TSX, dryRun);

	return [
		{ file: `${PAYLOAD_DIR}/serverFunction.ts`, action: "created" },
		{ file: `${PAYLOAD_DIR}/layout.tsx`, action: "modified" },
	];
}

export class InitError extends Error {}

export async function init(options: InitOptions) {
	const { cwd, dryRun } = options;

	const pkg = await readManifest(cwd);
	const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

	if (!allDeps.payload) {
		throw new InitError(
			"Payload CMS not found in dependencies. Is this a Payload project?",
		);
	}

	if (!allDeps.vinext) {
		throw new InitError(
			"vinext not found in dependencies. Run `vinext init` first.",
		);
	}

	if (dryRun) {
		console.log("Dry run — no files will be modified.\n");
	}

	console.log("Initializing vite-plugin-vinext-payload...\n");

	// Run independent transforms concurrently, sequential ones together
	const [viteConfigResults, serverFnResults, pageResult] = await Promise.all([
		addPayloadPluginToViteConfig(options),
		fixServerFunction(options),
		applyTemplate(
			cwd,
			`${ADMIN_DIR}/page.tsx`,
			"normalizeParams",
			PAGE_TSX,
			dryRun,
		),
	]);

	const results = [...viteConfigResults, ...serverFnResults, pageResult];

	// Add @cloudflare/vite-plugin to devDependencies if cloudflare() was added
	const addedCloudflare = viteConfigResults.some((r) =>
		r.reason?.includes("cloudflare"),
	);
	if (addedCloudflare && !allDeps["@cloudflare/vite-plugin"]) {
		const pkgPath = join(cwd, "package.json");
		const pkgContent = JSON.parse(await readFile(pkgPath, "utf8"));
		pkgContent.devDependencies = {
			...pkgContent.devDependencies,
			"@cloudflare/vite-plugin": "^1",
		};
		await maybeWrite(
			pkgPath,
			JSON.stringify(pkgContent, null, 2) + "\n",
			dryRun,
		);
		results.push({
			file: "package.json",
			action: "modified",
			reason: "added @cloudflare/vite-plugin",
		});
	}

	for (const r of results) {
		const icon =
			r.action === "created" ? "+" : r.action === "modified" ? "~" : "-";
		const msg = r.reason ? ` (${r.reason})` : "";
		console.log(`  ${icon} ${r.file}${msg}`);
	}

	const changed = results.filter((r) => r.action !== "skipped");
	console.log(
		`\n${changed.length} file(s) ${dryRun ? "would be " : ""}changed.`,
	);

	if (changed.length > 0 && !dryRun) {
		console.log("\nNext steps:");
		console.log("  1. npm install");
		console.log("  2. npx payload generate:importmap");
		console.log("  3. npm run dev");
	}
}
