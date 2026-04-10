import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// e2e tests scaffold real projects — run sequentially
		fileParallelism: false,
		testTimeout: 600_000,
		hookTimeout: 600_000,
	},
});
