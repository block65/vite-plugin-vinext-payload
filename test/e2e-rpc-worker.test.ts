/**
 * E2E test: vinextPayloadWorker for a headless RPC-only worker.
 *
 * Scaffolds a minimal Cloudflare worker that uses `@cloudflare/vite-plugin`
 * together with `vinextPayloadWorker`, installs the deps, and runs
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
import {
	CLOUDFLARE_V2_PACKAGES,
	cloudflareWorkerConfig,
	createProjectHelpers,
	disableNamedPlugins,
	packPlugin,
	VERSIONS,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-rpc-worker");

// Match the user-reported scenario: the parent worker is cloudflare-managed
// under the name "ssr". Our plugin's old top-level `ssr.external` block
// landed on this exact env, triggering @cloudflare/vite-plugin's
// validateWorkerEnvironmentOptions rejection. Naming the test env "ssr"
// reproduces that collision.
const WORKER_ENV = "ssr";
// Where @cloudflare/vite-plugin v2 writes the entry Worker's build
const WORKER_BUNDLE = join(
	".cloudflare",
	"output",
	"v0",
	"workers",
	"default",
	"bundle",
	"index.js",
);
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

const workerEntry = `import { WorkerEntrypoint } from "cloudflare:workers";
// Payload imports fileTypeFromFile, which only file-type's Node entry
// exports; Vite's default resolver picks core.js, so the build fails with
// MISSING_EXPORT unless payloadRscRuntime's resolveId wins ordering
import { fileTypeFromFile } from "file-type";

export class CmsEntrypoint extends WorkerEntrypoint {
	// Class field referencing fileTypeFromFile keeps Rolldown from
	// tree-shaking it — \`void X\` was getting elided.
	fileType = fileTypeFromFile;

	async ping() {
		const t = await this.fileType("/dev/null");
		return t ? "pong" : "pong";
	}
}

export default {
	fetch: () => new Response("rpc-only", { status: 404 }),
};
`;

const viteConfig = `import { cloudflare } from "@cloudflare/vite-plugin";
import { vinextPayloadWorker } from "vite-plugin-vinext-payload";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		cloudflare({ viteEnvironment: { name: "${WORKER_ENV}" } }),
		...vinextPayloadWorker({ env: "${WORKER_ENV}" }),
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
	await helpers.write(
		"cloudflare.config.ts",
		cloudflareWorkerConfig("rpc-worker"),
	);
	await helpers.write("vite.config.ts", viteConfig);
	await disableNamedPlugins(helpers);
	await helpers.write("tsconfig.json", tsconfig);
	await helpers.write("src/index.ts", workerEntry);

	await helpers.npm([
		"install",
		"-D",
		`vite@${VERSIONS.vite}`,
		...CLOUDFLARE_V2_PACKAGES,
		"@cloudflare/workers-types",
		"file-type@^21",
		"--ignore-scripts",
	]);
	await helpers.npm([
		"install",
		"-D",
		await packPlugin(PLUGIN_ROOT),
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
		const bundled = await helpers.read(WORKER_BUNDLE);
		expect(bundled).toContain("CmsEntrypoint");
	});

	it("bundles `file-type`'s Node entry, not core.js", async () => {
		// The build succeeding in the first test rules out core.js alone,
		// which would fail it with MISSING_EXPORT; this rules out a stub that
		// only satisfies the export
		const bundled = await helpers.read(WORKER_BUNDLE);

		expect(bundled).toContain("node_modules/file-type/index.js");
	});
});
