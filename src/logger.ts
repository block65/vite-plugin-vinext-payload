/**
 * Diagnostic logging for the plugin internals.
 *
 * This plugin patches other people's code at build time, so when a patch
 * silently misses the failure is invisible. Every optional path — a file that
 * didn't parse, a package that wasn't found, a feature test that missed —
 * logs here rather than vanishing into a bare `catch`.
 *
 * Off by default: plugin internals must not add noise to a consumer's build
 * output. Enable with `DEBUG=vinext-payload` (or `DEBUG=*`).
 *
 * This is diagnostics, not the CLI's user-facing output — that lives in
 * `bin/output.ts` and is always shown.
 */

const PREFIX = "[vinext-payload]";

const DEBUG_PATTERN = process.env["DEBUG"] ?? "";

const enabled =
	DEBUG_PATTERN === "*" || DEBUG_PATTERN.includes("vinext-payload");

/** `trace` and `debug` are gated; `info`, `warn` and `error` always surface. */
export const logger = {
	/**
	 * Always shown, no level word: the one-line-per-build disclosure of what
	 * this plugin does to other people's code. Not for diagnostics — those
	 * are `trace`/`debug`.
	 */
	info(message: string, ...detail: unknown[]): void {
		process.stderr.write(`${PREFIX} ${message}\n`);
		if (enabled) {
			logDetail(detail);
		}
	},

	trace(message: string, ...detail: unknown[]): void {
		if (enabled) {
			process.stderr.write(`${PREFIX} trace ${message}\n`);
			logDetail(detail);
		}
	},

	debug(message: string, ...detail: unknown[]): void {
		if (enabled) {
			process.stderr.write(`${PREFIX} debug ${message}\n`);
			logDetail(detail);
		}
	},

	warn(message: string, ...detail: unknown[]): void {
		process.stderr.write(`${PREFIX} warn ${message}\n`);
		if (enabled) {
			logDetail(detail);
		}
	},

	error(message: string, ...detail: unknown[]): void {
		process.stderr.write(`${PREFIX} error ${message}\n`);
		logDetail(detail);
	},
};

function logDetail(detail: unknown[]): void {
	for (const item of detail) {
		process.stderr.write(`${PREFIX}   ${formatDetail(item)}\n`);
	}
}

function formatDetail(item: unknown): string {
	if (item instanceof Error) {
		return item.stack ?? `${item.name}: ${item.message}`;
	}
	return typeof item === "string" ? item : JSON.stringify(item);
}
