/**
 * E2E test: the Cloudflare `vite.config.ts` the README documents, booted
 * verbatim. The README drops the options `vinext init` passes to `vinext()`,
 * and plugin order decides which plugin's `configEnvironment` hooks see the
 * `rsc` environment first, so the documented config needs proving on its own.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertStatus,
	createProjectHelpers,
	scaffoldCloudflareProject,
	startDevServer,
	waitForServerReady,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-readme-order");
const helpers = createProjectHelpers(TEST_DIR);

// The README's Cloudflare vite.config.ts block, read rather than copied so the
// two cannot drift
async function readReadmeViteConfig() {
	const readme = await readFile(join(PLUGIN_ROOT, "README.md"), "utf8");
	const block = readme
		.split("### Cloudflare Workers")[1]
		?.match(/```ts\n\/\/ vite\.config\.ts\n([\s\S]*?)```/)?.[1];
	if (!block) {
		throw new Error(
			"README has no vite.config.ts block under Cloudflare Workers",
		);
	}
	return block;
}

describe("e2e: README plugin order", () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;

	beforeAll(async () => {
		await scaffoldCloudflareProject(TEST_DIR, helpers, PLUGIN_ROOT);
		await helpers.write("vite.config.ts", await readReadmeViteConfig());
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
