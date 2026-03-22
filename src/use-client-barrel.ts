import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

/**
 * Propagates `'use client'` directives through barrel re-export files.
 *
 * Problem: plugin-rsc only checks each file individually for `'use client'`.
 * When a barrel file (`export { Foo } from './foo.js'`) re-exports from a
 * `'use client'` module, plugin-rsc doesn't see the directive on the barrel
 * and treats it as a server module. The component gets executed on the server
 * instead of being proxied as a client reference.
 *
 * Fix: detect pure re-export barrels in the RSC environment and check if
 * their targets have `'use client'`. If so, prepend the directive to the
 * barrel so plugin-rsc picks it up.
 *
 * This must run before plugin-rsc's `rsc:use-client` transform (`enforce: 'pre'`
 * is not needed since plugin-rsc uses a later order, but we use `enforce: 'pre'`
 * to be safe).
 */
export function payloadUseClientBarrel(): Plugin {
	// Cache resolved 'use client' status per file path
	const useClientCache = new Map<string, boolean>();

	return {
		name: "vite-plugin-payload:use-client-barrel",
		enforce: "pre",

		transform: {
			async handler(code, id) {
				if (this.environment?.name !== "rsc") {
					return;
				}

				// Skip if file already has 'use client'
				if (
					code.startsWith("'use client'") ||
					code.startsWith('"use client"')
				) {
					return;
				}

				// Only process files that are pure re-exports (no other code).
				// A pure re-export barrel contains only:
				// - export { ... } from '...'
				// - export * from '...'
				// - comments, whitespace, sourcemap URLs
				const stripped = code
					.replace(/\/\/.*$/gm, "") // line comments
					.replace(/\/\*[\s\S]*?\*\//g, "") // block comments
					.replace(/^\s*$/gm, "") // blank lines
					.trim();

				if (!stripped) return;

				// Check all lines are re-exports
				const lines = stripped.split("\n").map((l) => l.trim());
				const reExportPattern =
					/^export\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/;
				const starReExportPattern =
					/^export\s+\*\s+from\s+['"][^'"]+['"];?\s*$/;

				const isBarrel = lines.every(
					(line) =>
						!line ||
						reExportPattern.test(line) ||
						starReExportPattern.test(line),
				);

				if (!isBarrel) return;

				// Extract source paths from re-exports
				const sourcePattern = /from\s+['"]([^'"]+)['"]/g;
				const sources: string[] = [];
				let match;
				while ((match = sourcePattern.exec(code)) !== null) {
					sources.push(match[1]);
				}

				if (sources.length === 0) return;

				// Resolve each source and check for 'use client'
				for (const source of sources) {
					const resolved = await this.resolve(source, id);
					if (!resolved) continue;

					const resolvedPath = resolved.id;

					// Check cache first
					let hasUseClient = useClientCache.get(resolvedPath);
					if (hasUseClient === undefined) {
						try {
							const content = await readFile(resolvedPath, "utf-8");
							hasUseClient =
								content.startsWith("'use client'") ||
								content.startsWith('"use client"');
							useClientCache.set(resolvedPath, hasUseClient);
						} catch {
							continue;
						}
					}

					if (hasUseClient) {
						// Prepend 'use client' to the barrel
						return {
							code: `'use client';\n${code}`,
							map: null,
						};
					}
				}
			},
		},
	};
}
