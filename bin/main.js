#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"dry-run": { type: "boolean", default: false },
		cwd: { type: "string", default: "." },
		help: { type: "boolean", short: "h", default: false },
	},
});

const command = positionals[0];

if (values.help || !command) {
	console.log(
		`
Usage: vite-plugin-vinext-payload <command> [options]

Commands:
  init          Apply Payload-specific fixes for vinext compatibility

Options:
  --dry-run     Show what would change without writing files
  --cwd <path>  Project directory (default: .)
  -h, --help    Show this help
`.trimStart(),
	);
	process.exit(0);
}

if (command === "init") {
	const { init } = await import("./init.ts");
	await init({ cwd: resolve(values.cwd), dryRun: values["dry-run"] });
} else {
	console.error(`Unknown command: ${command}`);
	process.exit(1);
}
