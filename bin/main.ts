#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { dedent } from "../src/dedent.ts";
import { print, printError } from "./output.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"dry-run": { type: "boolean", default: false },
		cwd: { type: "string", default: "." },
		help: { type: "boolean", short: "h", default: false },
	},
});

const [command] = positionals;

if (values.help || !command) {
	print(
		dedent`
			Usage: vite-plugin-vinext-payload <command> [options]

			Commands:
				init          Deprecated: run vinext init, then add vinextPayload()

			Options:
				--dry-run     Show what would change without writing files
				--cwd <path>  Project directory (default: .)
				-h, --help    Show this help
			`,
	);
	process.exitCode = 0;
} else if (command === "init") {
	printError(
		"`vite-plugin-vinext-payload init` is deprecated and will be removed. Run `vinext init`, then add vinextPayload() after vinext() in vite.config.ts.",
	);
	const { init, InitError } = await import("./init.ts");
	try {
		await init({ cwd: resolve(values.cwd), dryRun: values["dry-run"] });
	} catch (e) {
		if (e instanceof InitError) {
			printError(e.message);
			process.exitCode = 1;
		} else {
			throw e;
		}
	}
} else {
	printError(`Unknown command: ${command}`);
	process.exitCode = 1;
}
