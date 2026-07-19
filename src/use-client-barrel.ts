import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { EnvironmentOptions, Plugin } from "vite";
import { isTruthy } from "./iife.ts";
import { logger } from "./logger.ts";
import { tryRead } from "./try-read.ts";

const RE_EXPORT_PATTERN = /^export\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/;
const STAR_RE_EXPORT_PATTERN = /^export\s+\*\s+from\s+['"][^'"]+['"];?\s*$/;
const EXPORT_SOURCE_RE = /from\s+['"]([^'"]+)['"]/g;

/**
 * Automatically excludes packages from RSC optimizeDeps when their
 * subpath exports are barrel files that re-export from `'use client'`
 * modules.
 *
 * Problem: pre-bundling (esbuild/Rolldown) merges barrel files with their
 * re-exported modules, stripping `'use client'` directives. plugin-rsc
 * can't detect the client boundary and executes the component on the server.
 *
 * Fix: at config time, scan `@payloadcms/*` subpath exports for this
 * pattern. Matching packages are excluded from RSC optimizeDeps so their
 * files go through the transform pipeline where plugin-rsc detects
 * `'use client'` on individual files.
 *
 * Upstream: @vitejs/plugin-rsc should follow re-export chains to detect
 * `'use client'` directives.
 */
export function payloadUseClientBarrel(): Plugin {
	let projectRoot = process.cwd();

	return {
		name: "vite-plugin-payload:use-client-barrel",

		config(config) {
			projectRoot = config.root ?? process.cwd();
		},

		async configEnvironment(name) {
			if (name !== "rsc") {
				return;
			}

			const excludes = await findBarrelClientPackages(
				["@payloadcms/"],
				projectRoot,
			);

			if (excludes.length === 0) {
				return;
			}

			return {
				optimizeDeps: {
					exclude: excludes,
				},
			} satisfies EnvironmentOptions;
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function findBarrelClientPackages(
	prefixes: string[],
	root: string,
): Promise<string[]> {
	const scopes = prefixes.flatMap((prefix) => {
		const [scope] = prefix.split("/");
		return prefix.startsWith("@") && scope ? [{ prefix, scope }] : [];
	});

	const perScope = await Promise.all(
		scopes.map(async ({ prefix, scope }) => {
			const scopeDir = join(root, "node_modules", scope);

			const entries = await readdir(scopeDir).catch((err: unknown) => {
				// The scope may simply not be installed — there is nothing to scan
				// and no exclude to contribute.
				logger.trace(`scope directory unreadable: ${scopeDir}`, err);
				return [];
			});

			const matches = await Promise.all(
				entries
					.map((entry) => ({ pkgName: `${scope}/${entry}`, entry }))
					.filter(({ pkgName }) => pkgName.startsWith(prefix))
					.map(async ({ pkgName, entry }) =>
						(await hasUseClientBarrelExport(join(scopeDir, entry)))
							? pkgName
							: undefined,
					),
			);

			return matches.filter(isTruthy);
		}),
	);

	return perScope.flat();
}

/** True if any non-root subpath export of the package is a broken barrel. */
async function hasUseClientBarrelExport(pkgDir: string): Promise<boolean> {
	const manifest = await readManifest(join(pkgDir, "package.json"));

	const exports = manifest?.exports;
	if (!isRecord(exports)) {
		return false;
	}

	const entryPaths = Object.entries(exports)
		.filter(([subpath]) => subpath !== ".")
		.map(([, exportEntry]) => resolveExportEntry(exportEntry))
		.filter(isTruthy);

	const barrels = await Promise.all(
		entryPaths.map((entryPath) =>
			isBarrelReExportingUseClient(resolve(pkgDir, entryPath)),
		),
	);

	return barrels.includes(true);
}

async function readManifest(
	path: string,
): Promise<{ exports?: unknown } | undefined> {
	const raw = await tryRead(path);
	if (raw === undefined) {
		return undefined;
	}

	try {
		return JSON.parse(raw);
	} catch (err) {
		logger.trace(`package.json did not parse: ${path}`, err);
		return undefined;
	}
}

/** Resolve a package.json exports entry to a file path. */
function resolveExportEntry(entry: unknown): string | undefined {
	if (typeof entry === "string") {
		return entry;
	}

	if (!isRecord(entry)) {
		return undefined;
	}

	for (const key of ["import", "default"]) {
		const value = entry[key];

		if (typeof value === "string") {
			return value;
		}

		if (isRecord(value)) {
			if (typeof value["default"] === "string") {
				return value["default"];
			}
			if (typeof value["import"] === "string") {
				return value["import"];
			}
		}
	}

	return undefined;
}

/** Check if a file is a pure barrel that re-exports from 'use client' modules. */
async function isBarrelReExportingUseClient(
	filePath: string,
): Promise<boolean> {
	const code = await tryRead(filePath);
	if (code === undefined) {
		return false;
	}

	// Already has 'use client' — not a broken barrel
	if (code.startsWith("'use client'") || code.startsWith('"use client"')) {
		return false;
	}

	const stripped = code
		.replace(/\/\/.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*$/gm, "")
		.trim();

	if (!stripped) {
		return false;
	}

	const lines = stripped.split("\n").map((l) => l.trim());

	const isBarrel = lines.every(
		(line) =>
			!line ||
			RE_EXPORT_PATTERN.test(line) ||
			STAR_RE_EXPORT_PATTERN.test(line),
	);
	if (!isBarrel) {
		return false;
	}

	const sources = [...code.matchAll(EXPORT_SOURCE_RE)].map((m) =>
		resolve(dirname(filePath), m[1]),
	);

	// A re-export target may not exist on disk (conditional exports, types-only
	// entries). `tryRead` traces the miss; an unreadable source simply carries no
	// directive, so the remaining sources still decide the answer.
	const contents = await Promise.all(
		sources.map(async (src) => (await tryRead(src)) ?? ""),
	);

	return contents.some(
		(content) =>
			content.startsWith("'use client'") || content.startsWith('"use client"'),
	);
}
