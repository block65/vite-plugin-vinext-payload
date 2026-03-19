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
