import { defineConfig } from "@block65/shared-config/oxfmt";

export default defineConfig({
	// A Git submodule; formatting it would dirty its working tree
	ignorePatterns: ["agent-standards"],
});
