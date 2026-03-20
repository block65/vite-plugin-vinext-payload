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
 * 4. Adds @payload-config path to tsconfig.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, Lang } from "@ast-grep/napi";
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

// ── Templates ──────────────────────────────────────────────────────

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

// ── Transforms ─────────────────────────────────────────────────────

function addPayloadPluginToViteConfig({ cwd, dryRun }: InitOptions): Result {
	const file = join(cwd, "vite.config.ts");
	if (!existsSync(file)) {
		return { file: "vite.config.ts", action: "skipped", reason: "not found" };
	}

	const content = readFileSync(file, "utf8");

	if (content.includes("payloadPlugin")) {
		return {
			file: "vite.config.ts",
			action: "skipped",
			reason: "payloadPlugin already present",
		};
	}

	const root = parse(Lang.TypeScript, content).root();

	// Find the vinext() call inside the plugins array
	const vinextCall = root.find({
		rule: {
			pattern: "vinext()",
			inside: {
				kind: "array",
				stopBy: "end",
			},
		},
	});

	if (!vinextCall) {
		return {
			file: "vite.config.ts",
			action: "skipped",
			reason: "could not find vinext() in plugins array",
		};
	}

	// Find the last import declaration to insert our import after it
	const allImports = root.findAll({ rule: { kind: "import_statement" } });
	const lastImport = allImports.at(-1);

	if (!lastImport) {
		return {
			file: "vite.config.ts",
			action: "skipped",
			reason: "no import statements found",
		};
	}

	// Find the plugins array containing vinext()
	const pluginsArray = vinextCall.parent();
	if (!pluginsArray || pluginsArray.kind() !== "array") {
		return {
			file: "vite.config.ts",
			action: "skipped",
			reason: "vinext() not inside an array",
		};
	}

	// Build edits: insert import after last import, insert plugin after vinext()
	const lastImportEnd = lastImport.range().end.index;
	// Match quote style from existing imports
	const quote = lastImport.text().includes("'") ? "'" : '"';
	const importLine = `\nimport { payloadPlugin } from ${quote}vite-plugin-vinext-payload${quote};`;

	// Detect indentation: use vinext()'s indentation, or infer from the array
	const vinextRange = vinextCall.range();
	const vinextLineStart =
		content.lastIndexOf("\n", vinextRange.start.index) + 1;
	const isSingleLine = !pluginsArray.text().includes("\n");

	let pluginInsert: string;
	let insertAt: number;

	if (isSingleLine) {
		// Single-line: [vinext()] → [vinext(), payloadPlugin()]
		pluginInsert = ", payloadPlugin()";
		// Insert right after vinext() call (before the optional comma or ])
		insertAt = vinextRange.end.index;
		// Skip past existing comma if present
		if (content[insertAt] === ",") {
			insertAt++;
		}
	} else {
		// Multi-line: insert on new line with matching indent
		const indent = content.slice(vinextLineStart, vinextRange.start.index);
		insertAt = vinextRange.end.index;
		const hasComma = content[insertAt] === ",";
		if (hasComma) {
			insertAt++;
		}
		// Add comma after vinext() if missing, then payloadPlugin() on next line
		pluginInsert = (hasComma ? "" : ",") + "\n" + indent + "payloadPlugin(),";
	}

	const updated =
		content.slice(0, lastImportEnd) +
		importLine +
		content.slice(lastImportEnd, insertAt) +
		pluginInsert +
		content.slice(insertAt);

	if (!dryRun) {
		writeFileSync(file, updated);
	}
	return { file: "vite.config.ts", action: "modified" };
}

function extractServerFunction({ cwd, dryRun }: InitOptions): Result {
	const serverFnFile = join(cwd, PAYLOAD_DIR, "serverFunction.ts");

	if (existsSync(serverFnFile)) {
		return {
			file: `${PAYLOAD_DIR}/serverFunction.ts`,
			action: "skipped",
			reason: "already exists",
		};
	}

	const layoutFile = join(cwd, PAYLOAD_DIR, "layout.tsx");
	if (!existsSync(layoutFile)) {
		return {
			file: `${PAYLOAD_DIR}/layout.tsx`,
			action: "skipped",
			reason: "not found",
		};
	}

	const layoutContent = readFileSync(layoutFile, "utf8");

	// Check if layout has inline 'use server' — if not, already migrated
	if (!layoutContent.includes("'use server'")) {
		return {
			file: `${PAYLOAD_DIR}/layout.tsx`,
			action: "skipped",
			reason: "no inline 'use server' found",
		};
	}

	if (!dryRun) {
		writeFileSync(serverFnFile, SERVER_FUNCTION_TS);
		writeFileSync(layoutFile, LAYOUT_TSX);
	}

	return { file: `${PAYLOAD_DIR}/serverFunction.ts`, action: "created" };
}

function updateLayout({ cwd, dryRun }: InitOptions): Result {
	const layoutFile = join(cwd, PAYLOAD_DIR, "layout.tsx");
	if (!existsSync(layoutFile)) {
		return {
			file: `${PAYLOAD_DIR}/layout.tsx`,
			action: "skipped",
			reason: "not found",
		};
	}

	const content = readFileSync(layoutFile, "utf8");

	if (content.includes("serverFunction.js")) {
		return {
			file: `${PAYLOAD_DIR}/layout.tsx`,
			action: "skipped",
			reason: "already imports serverFunction",
		};
	}

	if (!dryRun) {
		writeFileSync(layoutFile, LAYOUT_TSX);
	}
	return { file: `${PAYLOAD_DIR}/layout.tsx`, action: "modified" };
}

function addNormalizeParams({ cwd, dryRun }: InitOptions): Result {
	const file = join(cwd, ADMIN_DIR, "page.tsx");
	if (!existsSync(file)) {
		return {
			file: `${ADMIN_DIR}/page.tsx`,
			action: "skipped",
			reason: "not found",
		};
	}

	const content = readFileSync(file, "utf8");

	if (content.includes("normalizeParams")) {
		return {
			file: `${ADMIN_DIR}/page.tsx`,
			action: "skipped",
			reason: "normalizeParams already present",
		};
	}

	if (!dryRun) {
		writeFileSync(file, PAGE_TSX);
	}
	return { file: `${ADMIN_DIR}/page.tsx`, action: "modified" };
}

function addTsconfigPath({ cwd, dryRun }: InitOptions): Result {
	const file = join(cwd, "tsconfig.json");
	if (!existsSync(file)) {
		return { file: "tsconfig.json", action: "skipped", reason: "not found" };
	}

	const content = readFileSync(file, "utf8");

	if (content.includes("@payload-config")) {
		return {
			file: "tsconfig.json",
			action: "skipped",
			reason: "@payload-config already present",
		};
	}

	// tsconfig.json may have comments (JSONC) so we use string manipulation
	const configPath = existsSync(join(cwd, "src/payload.config.ts"))
		? "./src/payload.config.ts"
		: "./payload.config.ts";

	let updated = content;

	if (updated.includes('"paths"')) {
		updated = updated.replace(
			/("paths"\s*:\s*\{)/,
			`$1\n      "@payload-config": ["${configPath}"],`,
		);
	} else if (updated.includes('"compilerOptions"')) {
		updated = updated.replace(
			/("compilerOptions"\s*:\s*\{)/,
			`$1\n    "paths": {\n      "@payload-config": ["${configPath}"]\n    },`,
		);
	}

	if (updated !== content) {
		if (!dryRun) {
			writeFileSync(file, updated);
		}
		return { file: "tsconfig.json", action: "modified" };
	}

	return {
		file: "tsconfig.json",
		action: "skipped",
		reason: "could not find insertion point",
	};
}

// ── Main ───────────────────────────────────────────────────────────

export async function init(options: InitOptions) {
	const { cwd, dryRun } = options;

	// Validate: is this a Payload project?
	const pkgFile = join(cwd, "package.json");
	if (!existsSync(pkgFile)) {
		console.error("No package.json found. Run this from your project root.");
		process.exit(1);
	}

	const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
	const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

	if (!allDeps.payload) {
		console.error(
			"Payload CMS not found in dependencies. Is this a Payload project?",
		);
		process.exit(1);
	}

	if (!allDeps.vinext) {
		console.error("vinext not found in dependencies. Run `vinext init` first.");
		process.exit(1);
	}

	if (dryRun) {
		console.log("Dry run — no files will be modified.\n");
	}

	console.log("Initializing vite-plugin-vinext-payload...\n");

	const results: Result[] = [
		addPayloadPluginToViteConfig(options),
		addTsconfigPath(options),
		extractServerFunction(options),
		updateLayout(options),
		addNormalizeParams(options),
	];

	// Print results
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
