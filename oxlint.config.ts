import { defineConfig } from "@block65/shared-config/oxlint";

export default defineConfig({
	// A Git submodule with its own lint config
	ignorePatterns: ["agent-standards"],
	rules: {
		// Vitest's `expect` takes a failure message as its second argument
		"vitest/valid-expect": ["error", { maxArgs: 2 }],
	},
});
