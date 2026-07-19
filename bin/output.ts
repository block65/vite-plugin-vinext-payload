/**
 * User-facing CLI output.
 *
 * Distinct from `src/logger.ts`: this is the program's product, not
 * diagnostics. It is never level-filtered and never suppressed — when someone
 * runs the CLI, this is what they came for. Routed through here so no module
 * calls `console.*` directly.
 */

/** Normal output. Goes to stdout so it can be piped. */
export function print(message = ""): void {
	process.stdout.write(`${message}\n`);
}

/** Failures. Goes to stderr so it survives stdout redirection. */
export function printError(message: string): void {
	process.stderr.write(`${message}\n`);
}
