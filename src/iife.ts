/**
 * Local stand-ins for `@block65/toolkit`, which is not published to npm.
 * Kept minimal and local; move to the shared toolkit if it ever ships.
 */

/** Compute a `const` needing branching logic, instead of `let` + reassignment. */
export function iife<T>(fn: () => T): T {
	return fn();
}

/** Typed replacement for `.filter(Boolean)`, which TypeScript cannot narrow. */
export function isTruthy<T>(
	value: T | null | undefined | false | "",
): value is T {
	return Boolean(value);
}
