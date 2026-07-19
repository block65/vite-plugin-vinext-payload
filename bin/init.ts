/**
 * `vite-plugin-vinext-payload init`
 *
 * Applies Payload-specific fixes to a vinext project.
 * Run this after `vinext init` and `npm install -D vite-plugin-vinext-payload`.
 *
 * Transforms:
 * 1. Adds vinextPayload() to vite.config.ts
 * 2. Extracts serverFunction from layout.tsx into a 'use server' module
 * 3. Adds normalizeParams to admin page.tsx
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { parse, Lang } from "@ast-grep/napi";
import { dedent } from "../src/dedent.ts";
import { iife, isTruthy } from "../src/iife.ts";
import { tryRead } from "../src/try-read.ts";
import { print } from "./output.ts";

interface InitOptions {
	cwd: string;
	dryRun: boolean;
}

interface Result {
	file: string;
	action: "created" | "modified" | "skipped";
	reason?: string;
}

/** The parts of a package.json this command reads. */
interface Manifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

/** Result of one edit to a file's text, plus what to report about it. */
interface Edit {
	content: string;
	result?: Result;
}

const PAYLOAD_DIR = "src/app/(payload)";
const ADMIN_DIR = `${PAYLOAD_DIR}/admin/[[...segments]]`;

const WRANGLER_CONFIG_FILES = [
	"wrangler.jsonc",
	"wrangler.json",
	"wrangler.toml",
];

async function findWranglerConfig(cwd: string): Promise<string | undefined> {
	const exists = await Promise.all(
		WRANGLER_CONFIG_FILES.map((file) =>
			access(join(cwd, file)).then(
				() => true,
				() => false,
			),
		),
	);
	const matchIndex = exists.findIndex(Boolean);
	return matchIndex === -1 ? undefined : WRANGLER_CONFIG_FILES[matchIndex];
}

async function hasWranglerConfig(cwd: string): Promise<boolean> {
	return (await findWranglerConfig(cwd)) !== undefined;
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

  // vinext passes segments=[] for /admin, Next.js omits the key entirely, and
  // Payload only resolves the dashboard route when it is absent. Drop the key
  // so both frameworks land on the same route.
  const normalizeParams = async (params: Args['params']) => {
    const resolved = await params
    // Array.isArray is the guard, not a style choice: Next.js omits the key
    // entirely, so reading .length off it directly throws at request time.
    if (Array.isArray(resolved.segments) && resolved.segments.length === 0) {
      const { segments, ...rest } = resolved
      return rest
    }
    return resolved
  }

  export const generateMetadata = ({ params, searchParams }: Args): Promise<Metadata> =>
    generatePageMetadata({ config, params: normalizeParams(params), searchParams })

  const Page = ({ params, searchParams }: Args) =>
    // RootPage types segments as required; its runtime reads a missing value as
    // the dashboard root. Remove this directive if Payload widens the type.
    // @ts-expect-error segments is optional at runtime
    RootPage({ config, params: normalizeParams(params), searchParams, importMap })

  export default Page
`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A dependency map: every value must be a version string. */
function isDependencyMap(value: unknown): value is Record<string, string> {
	return (
		isRecord(value) &&
		Object.values(value).every((version) => typeof version === "string")
	);
}

function isManifest(value: unknown): value is Manifest {
	return (
		isRecord(value) &&
		(value.dependencies === undefined || isDependencyMap(value.dependencies)) &&
		(value.devDependencies === undefined ||
			isDependencyMap(value.devDependencies))
	);
}

function parseJson(content: string, file: string): unknown {
	try {
		return JSON.parse(content);
	} catch {
		throw new InitError(`${file} contains invalid JSON.`);
	}
}

async function readManifest(cwd: string): Promise<Manifest> {
	const content = await tryRead(join(cwd, "package.json"));
	if (!content) {
		throw new InitError(
			"No package.json found. Run this from your project root.",
		);
	}

	const parsed = parseJson(content, "package.json");

	if (!isManifest(parsed)) {
		throw new InitError(
			"package.json is not a valid manifest (dependencies must map names to version strings).",
		);
	}

	return parsed;
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

/**
 * $$$ARGS: vinext 1.0's own init writes `vinext({ cache: ... })`; a bare
 * `vinext()` pattern only matches the zero-argument call.
 */
function findVinextCall(source: string) {
	return parse(Lang.TypeScript, source)
		.root()
		.find({
			rule: {
				pattern: "vinext($$$ARGS)",
				inside: { kind: "array", stopBy: "end" },
			},
		});
}

function findLastImport(source: string) {
	return parse(Lang.TypeScript, source)
		.root()
		.findAll({ rule: { kind: "import_statement" } })
		.at(-1);
}

function addPayloadPlugin(source: string): Edit {
	// Both spellings: a config initialized before the rename still carries
	// `payloadPlugin`, and re-running init must not insert a second call.
	if (source.includes("vinextPayload") || source.includes("payloadPlugin")) {
		return {
			content: source,
			result: {
				file: "vite.config.ts",
				action: "skipped",
				reason: "vinextPayload already present",
			},
		};
	}

	const vinextCall = findVinextCall(source);
	if (!vinextCall) {
		return {
			content: source,
			result: {
				file: "vite.config.ts",
				action: "skipped",
				reason: "could not find vinext() in plugins array",
			},
		};
	}

	const lastImport = findLastImport(source);
	if (!lastImport) {
		return {
			content: source,
			result: {
				file: "vite.config.ts",
				action: "skipped",
				reason: "no import statements found",
			},
		};
	}

	const pluginsArray = vinextCall.parent();
	if (!pluginsArray || pluginsArray.kind() !== "array") {
		return {
			content: source,
			result: {
				file: "vite.config.ts",
				action: "skipped",
				reason: "vinext() not inside an array",
			},
		};
	}

	const lastImportEnd = lastImport.range().end.index;
	const quote = lastImport.text().includes("'") ? "'" : '"';
	const importLine = `\nimport vinextPayload from ${quote}vite-plugin-vinext-payload${quote};`;

	const vinextRange = vinextCall.range();
	const vinextLineStart = source.lastIndexOf("\n", vinextRange.start.index) + 1;
	const isSingleLine = !pluginsArray.text().includes("\n");

	const { pluginInsert, insertAt } = isSingleLine
		? {
				pluginInsert: ", vinextPayload()",
				insertAt:
					source[vinextRange.end.index] === ","
						? vinextRange.end.index + 1
						: vinextRange.end.index,
			}
		: iife(() => {
				const indent = source.slice(vinextLineStart, vinextRange.start.index);
				const hasComma = source[vinextRange.end.index] === ",";
				return {
					pluginInsert:
						(hasComma ? "" : ",") + "\n" + indent + "vinextPayload(),",
					insertAt: hasComma
						? vinextRange.end.index + 1
						: vinextRange.end.index,
				};
			});

	return {
		content:
			source.slice(0, lastImportEnd) +
			importLine +
			source.slice(lastImportEnd, insertAt) +
			pluginInsert +
			source.slice(insertAt),
		result: { file: "vite.config.ts", action: "modified" },
	};
}

function addCloudflarePlugin(source: string): Edit {
	const vinextCall = findVinextCall(source);
	const lastImport = findLastImport(source);

	if (!vinextCall || !lastImport) {
		return { content: source };
	}

	const quote = lastImport.text().includes("'") ? "'" : '"';
	const importLine = `\nimport { cloudflare } from ${quote}@cloudflare/vite-plugin${quote};`;
	const lastImportEnd = lastImport.range().end.index;

	const pluginsArray = vinextCall.parent();
	const vinextRange = vinextCall.range();
	const isSingleLine = pluginsArray && !pluginsArray.text().includes("\n");

	const cfPlugin =
		'cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })';

	const vinextLineStart = source.lastIndexOf("\n", vinextRange.start.index) + 1;

	// cloudflare() goes before vinext()
	const { cfInsert, cfInsertAt } = iife(() => {
		if (isSingleLine) {
			return {
				cfInsert: `${cfPlugin}, `,
				cfInsertAt: vinextRange.start.index,
			};
		}

		const indent = source.slice(vinextLineStart, vinextRange.start.index);
		return {
			cfInsert: `${indent}${cfPlugin},\n`,
			cfInsertAt: vinextLineStart,
		};
	});

	return {
		content:
			source.slice(0, lastImportEnd) +
			importLine +
			source.slice(lastImportEnd, cfInsertAt) +
			cfInsert +
			source.slice(cfInsertAt),
		result: {
			file: "vite.config.ts",
			action: "modified",
			reason: "added cloudflare() for wrangler config",
		},
	};
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

	const pluginEdit = addPayloadPlugin(content);

	const needsCloudflare =
		(await hasWranglerConfig(cwd)) &&
		!pluginEdit.content.includes("@cloudflare/vite-plugin");

	const cloudflareEdit = needsCloudflare
		? addCloudflarePlugin(pluginEdit.content)
		: undefined;

	const updated = cloudflareEdit?.content ?? pluginEdit.content;
	const results = [pluginEdit.result, cloudflareEdit?.result].filter(isTruthy);

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

	const serverFnContent = await tryRead(serverFnFile);
	if (serverFnContent) {
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

/** Rewrites package.json in place, preserving every field it does not touch. */
async function addCloudflareDependency(
	cwd: string,
	dryRun: boolean,
): Promise<Result> {
	const pkgPath = join(cwd, "package.json");
	const parsed = parseJson(await readFile(pkgPath, "utf8"), "package.json");

	if (!isRecord(parsed)) {
		throw new InitError("package.json is not a JSON object.");
	}

	const devDependencies = {
		...(isRecord(parsed.devDependencies) ? parsed.devDependencies : undefined),
		"@cloudflare/vite-plugin": "^1",
	};

	await maybeWrite(
		pkgPath,
		JSON.stringify({ ...parsed, devDependencies }, null, 2) + "\n",
		dryRun,
	);

	return {
		file: "package.json",
		action: "modified",
		reason: "added @cloudflare/vite-plugin",
	};
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
		print("Dry run — no files will be modified.\n");
	}

	print("Initializing vite-plugin-vinext-payload...\n");

	// Safe to run concurrently: each transform owns a different file
	// (vite.config, the server function module, admin page.tsx).
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

	const addedCloudflare = viteConfigResults.some((r) =>
		r.reason?.includes("cloudflare"),
	);

	const cloudflareDepResult =
		addedCloudflare && !allDeps["@cloudflare/vite-plugin"]
			? await addCloudflareDependency(cwd, dryRun)
			: undefined;

	const results = [
		...viteConfigResults,
		...serverFnResults,
		pageResult,
		cloudflareDepResult,
	].filter(isTruthy);

	for (const r of results) {
		const icon = iife(() => {
			switch (r.action) {
				case "created":
					return "+";
				case "modified":
					return "~";
				default:
					return "-";
			}
		});
		const msg = r.reason ? ` (${r.reason})` : "";
		print(`  ${icon} ${r.file}${msg}`);
	}

	const changed = results.filter((r) => r.action !== "skipped");
	print(`\n${changed.length} file(s) ${dryRun ? "would be " : ""}changed.`);

	if (changed.length > 0 && !dryRun) {
		print("\nNext steps:");
		print("  1. npm install");
		print("  2. npx payload generate:importmap");
		print("  3. npm run dev");
	}
}
