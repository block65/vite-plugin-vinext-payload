#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { dedent } from "../src/dedent.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"dry-run": { type: "boolean", default: false },
		cwd: { type: "string", default: "." },
		help: { type: "boolean", short: "h", default: false },
	},
});

const [command] = positionals;

switch (true) {
	case values.help || !command:
		console.log(
			dedent`
				Usage: vite-plugin-vinext-payload <command> [options]

				Commands:
					init          Apply Payload-specific fixes for vinext compatibility

				Options:
					--dry-run     Show what would change without writing files
					--cwd <path>  Project directory (default: .)
					-h, --help    Show this help
				`,
		);
		break;

	case command === "init": {
		const { init, InitError } = await import("./init.ts");
		try {
			await init({ cwd: resolve(values.cwd), dryRun: values["dry-run"] });
		} catch (e) {
			if (e instanceof InitError) {
				console.error(e.message);
				process.exitCode = 1;
				break;
			}
			throw e;
		}
		break;
	}

	default:
		console.error(`Unknown command: ${command}`);
		process.exitCode = 1;
}
