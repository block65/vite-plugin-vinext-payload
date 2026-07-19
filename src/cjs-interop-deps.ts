import type { PatchDeclaration } from "./patch-manifest.ts";

/**
 * Packages whose CJS default exports need proper interop wrapping.
 * Without this, `import pluralize from "pluralize"` gets `{ default: fn }`
 * instead of `fn`.
 *
 * Be precise — broad globs like `payload/**` break ESM subpaths like
 * `payload/shared` that don't need interop.
 */
export const payloadCjsInteropDeps: readonly string[] = [
	"pluralize",
	"bson-objectid",
];

export const cjsInteropPatch = {
	id: "cjs-default-interop",
	kind: "transform",
	targets: ["pluralize, bson-objectid — via vite-plugin-cjs-interop"],
	reason:
		"their CJS default exports arrive as { default: fn } without interop wrapping, so calls like pluralize('item') break at runtime",
	removeWhen: "these packages ship native ESM",
	untracked: true,
} satisfies PatchDeclaration;
