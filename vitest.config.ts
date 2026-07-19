import { defineConfig } from "vitest/config";

// Applies to every project: spies are restored and vi.fn() implementations
// reset between tests, so no test can leak mock state into the next one.
const mockHygiene = {
	restoreMocks: true,
	mockReset: true,
} as const;

export default defineConfig({
	test: {
		...mockHygiene,
		projects: [
			{
				test: {
					...mockHygiene,
					name: "unit",
					include: ["test/*.test.ts"],
					exclude: ["test/e2e*.test.ts"],
					// No timeout overrides — the unit suite runs on vitest's
					// default budgets. If a unit test needs more, that is a signal.
				},
			},
			{
				test: {
					...mockHygiene,
					name: "e2e",
					include: ["test/e2e*.test.ts"],
					// e2e tests scaffold real projects, install dependencies and
					// boot dev servers — run sequentially with a long budget.
					fileParallelism: false,
					testTimeout: 600_000,
					hookTimeout: 600_000,
				},
			},
		],
	},
});
