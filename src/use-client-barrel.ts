import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { EnvironmentOptions, Plugin } from "vite";

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

/**
 * Scan node_modules for packages whose subpath exports are barrels
 * that re-export from `'use client'` modules.
 */
async function* findBarrelClientPackagesIter(
	prefixes: string[],
	root: string,
): AsyncGenerator<string> {
	for await (const prefix of prefixes) {
		const scope = prefix.startsWith("@") ? prefix.split("/")[0] : null;
		if (!scope) {
			continue;
		}

		const scopeDir = join(root, "node_modules", scope);
		let entries: string[];
		try {
			entries = await readdir(scopeDir);
		} catch {
			continue;
		}

		for await (const entry of entries) {
			const pkgName = `${scope}/${entry}`;
			if (!pkgName.startsWith(prefix)) {
				continue;
			}

			const pkgDir = join(scopeDir, entry);
			const pkgJsonPath = join(pkgDir, "package.json");

			let pkgJson: { exports?: Record<string, unknown> };
			try {
				pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf-8"));
			} catch {
				continue;
			}

			const exports = pkgJson.exports;
			if (!exports || typeof exports !== "object") {
				continue;
			}

			for await (const [subpath, exportEntry] of Object.entries(exports)) {
				if (subpath === ".") {
					continue;
				}

				const entryPath = resolveExportEntry(exportEntry);
				if (!entryPath) {
					continue;
				}

				const fullPath = resolve(pkgDir, entryPath);
				if (await isBarrelReExportingUseClient(fullPath)) {
					yield pkgName;
					break;
				}
			}
		}
	}
}

async function findBarrelClientPackages(
	prefixes: string[],
	root: string,
): Promise<string[]> {
	const results: string[] = [];
	for await (const pkg of findBarrelClientPackagesIter(prefixes, root)) {
		results.push(pkg);
	}
	return results;
}

/** Resolve a package.json exports entry to a file path. */
function resolveExportEntry(entry: unknown): string | null {
	if (typeof entry === "string") {
		return entry;
	}
	if (entry && typeof entry === "object") {
		const obj = entry as Record<string, unknown>;
		for (const key of ["import", "default"]) {
			const val = obj[key];
			if (typeof val === "string") {
				return val;
			}
			if (val && typeof val === "object") {
				const nested = val as Record<string, unknown>;
				if (typeof nested.default === "string") {
					return nested.default;
				}
				if (typeof nested.import === "string") {
					return nested.import;
				}
			}
		}
	}
	return null;
}

// Pre-compiled regexes for barrel detection
const RE_EXPORT_PATTERN = /^export\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/;
const STAR_RE_EXPORT_PATTERN = /^export\s+\*\s+from\s+['"][^'"]+['"];?\s*$/;
const EXPORT_SOURCE_RE = /from\s+['"]([^'"]+)['"]/g;

/** Check if a file is a pure barrel that re-exports from 'use client' modules. */
async function isBarrelReExportingUseClient(
	filePath: string,
): Promise<boolean> {
	let code: string;
	try {
		code = await readFile(filePath, "utf-8");
	} catch {
		return false;
	}

	// Already has 'use client' — not a broken barrel
	if (code.startsWith("'use client'") || code.startsWith('"use client"')) {
		return false;
	}

	// Strip comments and blank lines
	const stripped = code
		.replace(/\/\/.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*$/gm, "")
		.trim();

	if (!stripped) {
		return false;
	}

	// Check all lines are re-exports
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

	// Check re-export targets for 'use client'
	const sources = [...code.matchAll(EXPORT_SOURCE_RE)].map((m) =>
		resolve(dirname(filePath), m[1]),
	);

	const contents = await Promise.all(
		sources.map((src) => readFile(src, "utf-8").catch(() => "")),
	);

	return contents.some(
		(content) =>
			content.startsWith("'use client'") || content.startsWith('"use client"'),
	);
}
