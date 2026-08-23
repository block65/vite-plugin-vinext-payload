/**
 * E2E test: the plugin order the README documents.
 *
 * Every other suite boots the config `init` writes — `vinext()`,
 * `vinextPayload()`, `cloudflare()`. The README documents the reverse for
 * Cloudflare Workers, and a consumer following it hit a boot crash no suite
 * here reproduces. Plugin order decides which plugin's `config` and
 * `configEnvironment` hooks see the `rsc` environment first, so the two
 * orders are not interchangeable and both need proving.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertStatus,
	createProjectHelpers,
	fixWranglerForLocalDev,
	installVinextStack,
	rewritePayloadConfigForVinext,
	startDevServer,
	VERSIONS,
	waitForServerReady,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-readme-order");
const helpers = createProjectHelpers(TEST_DIR);

// Verbatim from README.md's "For Cloudflare Workers with RSC" example.
const README_VITE_CONFIG = `import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import vinextPayload from "vite-plugin-vinext-payload";

export default defineConfig({
	plugins: [
		cloudflare({
			viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
		}),
		vinext(),
		vinextPayload(),
	],
});
`;

async function scaffoldProject() {
	await helpers.cleanup();
	const { mkdir } = await import("node:fs/promises");
	await mkdir(TEST_DIR, { recursive: true });
	await helpers.npx([
		"--yes",
		"degit",
		"--force",
		`payloadcms/payload/templates/with-cloudflare-d1#v${VERSIONS.payload}`,
		TEST_DIR,
	]);

	await writeFile(
		join(TEST_DIR, ".env"),
		`PAYLOAD_SECRET=${crypto.randomUUID()}\n`,
	);

	await installVinextStack(helpers, PLUGIN_ROOT, "cloudflare");

	await rewritePayloadConfigForVinext(helpers);
	await fixWranglerForLocalDev(helpers);
}

describe("e2e: README plugin order", () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;

	beforeAll(async () => {
		await scaffoldProject();
		await helpers.npx(["vite-plugin-vinext-payload", "init"]);

		// init writes its own order; the point of this suite is the other one.
		await helpers.write("vite.config.ts", README_VITE_CONFIG);

		await helpers.npm(["install"]);
		await helpers.npx(["payload", "generate:importmap"]);

		server = await startDevServer(TEST_DIR, helpers);
		await waitForServerReady(server.proc, server.port, "/admin");
	});

	afterAll(async () => {
		await server?.kill();
	});

	it("serves the admin UI booted in the documented plugin order", async () => {
		await assertStatus(server.port, "/admin", [200, 302, 307]);
	});
});
