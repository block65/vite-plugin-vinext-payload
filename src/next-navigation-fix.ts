import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parse, Lang } from "@ast-grep/napi";
import type { Plugin } from "vite";

/**
 * Fixes hydration mismatches caused by vinext's navigation shim
 * (`next/navigation`) returning different values during SSR vs client
 * hydration.
 *
 * The shim's `usePathname`, `useSearchParams`, and `useParams` hooks
 * use `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`.
 * The `getServerSnapshot` callbacks read from a module-level server
 * context that is `null` on the client, so during hydration React
 * gets fallback values ("/" for pathname, empty params/search) instead
 * of the real URL values — causing mismatches in every component that
 * renders differently based on the current route.
 *
 * The fix patches vinext's navigation shim on disk during
 * `configResolved` — before the optimizer runs. This ensures the
 * corrected code is picked up by pre-bundling without needing to
 * modify optimizeDeps include/exclude lists. The patch is idempotent
 * (already-patched files are detected and skipped).
 *
 * Remove: when vinext's navigation shim uses React context for these
 * hooks, matching Next.js's `PathnameContext` / `SearchParamsContext`.
 */

const PATCH_MARKER = "/* patched:next-navigation-fix */";

function patchNavigation(code: string): string {
	// Find all useSyncExternalStore(subscribeToNavigation, clientSnapshot, serverSnapshot)
	// calls and replace the 3rd arg (serverSnapshot) with the 2nd (clientSnapshot).
	// This ensures hydration uses the same snapshot as the client, preventing
	// mismatches from the server context being null on the client.
	const root = parse(Lang.JavaScript, code).root();
	const calls = root.findAll(
		"$OBJ.useSyncExternalStore(subscribeToNavigation, $CLIENT, $SERVER)",
	);

	const edits = [];
	for (const call of calls) {
		const clientArg = call.getMatch("CLIENT");
		const serverArg = call.getMatch("SERVER");
		if (clientArg && serverArg && clientArg.text() !== serverArg.text()) {
			edits.push(serverArg.replace(clientArg.text()));
		}
	}

	if (edits.length === 0) {
		return code;
	}

	return root.commitEdits(edits);
}

function findNavigationShimFromAliases(aliases: unknown): string | null {
	if (!aliases || typeof aliases !== "object") {
		return null;
	}

	const check = (value: unknown): string | null => {
		if (typeof value !== "string") {
			return null;
		}
		const path = value.endsWith(".js") ? value : `${value}.js`;
		return existsSync(path) ? path : null;
	};

	if (Array.isArray(aliases)) {
		for (const entry of aliases) {
			if (
				typeof entry === "object" &&
				entry !== null &&
				"find" in entry &&
				"replacement" in entry &&
				/^next\/navigation(\.js)?$/.test(String(entry.find))
			) {
				return check(entry.replacement);
			}
		}
	} else {
		for (const [key, value] of Object.entries(
			aliases as Record<string, unknown>,
		)) {
			if (/^next\/navigation(\.js)?$/.test(key)) {
				return check(value);
			}
		}
	}
	return null;
}

export function payloadNextNavigationFix(): Plugin {
	return {
		name: "vite-plugin-payload:next-navigation-fix",

		configResolved(config) {
			const shimPath = findNavigationShimFromAliases(config.resolve.alias);
			if (!shimPath) {
				return;
			}

			let code: string;
			try {
				code = readFileSync(shimPath, "utf-8");
			} catch {
				return;
			}

			// Already patched — skip
			if (code.includes(PATCH_MARKER)) {
				return;
			}

			if (
				!code.includes("usePathname") ||
				!code.includes("useSyncExternalStore")
			) {
				return;
			}

			const patched = patchNavigation(code);
			if (patched === code) {
				return;
			}

			writeFileSync(shimPath, PATCH_MARKER + "\n" + patched);
		},
	};
}
