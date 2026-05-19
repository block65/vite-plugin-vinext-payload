/**
 * E2E test: payloadWorkerPlugin for a headless RPC-only worker.
 *
 * Scaffolds a minimal Cloudflare worker that uses `@cloudflare/vite-plugin`
 * together with `payloadWorkerPlugin`, installs the deps, and runs
 * `vite build`. This exercises the `configResolved` validation in
 * @cloudflare/vite-plugin — if the plugin sets `resolve.external` on any
 * cloudflare-managed environment, the cloudflare plugin throws
 * `validateWorkerEnvironmentOptions`.
 *
 * The worker entry is a stub `WorkerEntrypoint` (no Payload) — the test
 * targets the plugin/cloudflare-plugin wiring, not Payload itself.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectHelpers } from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-rpc-worker");

// Match the user-reported scenario: the parent worker is cloudflare-managed
// under the name "ssr". Our plugin's old top-level `ssr.external` block
// landed on this exact env, triggering @cloudflare/vite-plugin's
// validateWorkerEnvironmentOptions rejection. Naming the test env "ssr"
// reproduces that collision.
const WORKER_ENV = "ssr";
const helpers = createProjectHelpers(TEST_DIR);

const packageJson = JSON.stringify(
	{
		name: "rpc-worker-test",
		private: true,
		type: "module",
		scripts: { build: "vite build" },
	},
	null,
	2,
);

const wranglerJsonc = JSON.stringify(
	{
		name: "rpc-worker",
		main: "src/index.ts",
		compatibility_date: "2025-01-01",
		compatibility_flags: ["nodejs_compat"],
	},
	null,
	2,
);

const workerEntry = `import { WorkerEntrypoint } from "cloudflare:workers";

export class CmsEntrypoint extends WorkerEntrypoint {
	ping() {
		return "pong";
	}
}

export default {
	fetch: () => new Response("rpc-only", { status: 404 }),
};
`;

const viteConfig = `import { cloudflare } from "@cloudflare/vite-plugin";
import { payloadWorkerPlugin } from "vite-plugin-vinext-payload";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		cloudflare({ viteEnvironment: { name: "${WORKER_ENV}" } }),
		...payloadWorkerPlugin({ env: "${WORKER_ENV}" }),
	],
});
`;

const tsconfig = JSON.stringify(
	{
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "bundler",
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			types: ["@cloudflare/workers-types"],
		},
		include: ["src", "vite.config.ts"],
	},
	null,
	2,
);

async function scaffoldRpcWorker() {
	await helpers.cleanup();
	await mkdir(TEST_DIR, { recursive: true });

	await helpers.write("package.json", packageJson);
	await helpers.write("wrangler.jsonc", wranglerJsonc);
	await helpers.write("vite.config.ts", viteConfig);
	await helpers.write("tsconfig.json", tsconfig);
	await helpers.write("src/index.ts", workerEntry);

	await helpers.npm([
		"install",
		"-D",
		"vite@^8",
		"@cloudflare/vite-plugin@^1.37",
		"@cloudflare/workers-types",
		"--legacy-peer-deps",
		"--ignore-scripts",
	]);
	await helpers.npm([
		"install",
		"-D",
		PLUGIN_ROOT,
		"--legacy-peer-deps",
		"--ignore-scripts",
	]);
}

describe("e2e: rpc worker", () => {
	beforeAll(async () => {
		await scaffoldRpcWorker();
	}, 300_000);

	afterAll(async () => {
		await helpers.cleanup();
	});

	it("vite build resolves config without resolve.external rejection", async () => {
		// If the plugin sets `resolve.external` on a cloudflare-managed env,
		// configResolved throws `validateWorkerEnvironmentOptions` and the
		// build aborts before any bundling happens.
		const output = await helpers.npm(["run", "build"]);
		expect(output).not.toMatch(/resolve\.external/);
		expect(output).not.toMatch(/incompatible with the Cloudflare Vite plugin/);
	}, 120_000);

	it("emits a bundle containing the WorkerEntrypoint export", async () => {
		const files = await import("node:fs/promises").then((m) =>
			m.readdir(join(TEST_DIR, "dist", WORKER_ENV)),
		);
		const jsEntry = files.find((f: string) => f.endsWith(".js"));
		expect(jsEntry).toBeDefined();
		const bundled = await helpers.read(
			join("dist", WORKER_ENV, jsEntry as string),
		);
		expect(bundled).toContain("CmsEntrypoint");
	});
});
