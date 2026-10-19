/**
 * E2E test: Cloudflare D1 (workerd).
 *
 * Scaffolds a Payload project from the with-cloudflare-d1 template,
 * migrates to vinext, and verifies Payload works inside workerd.
 * Tests the admin UI to exercise React module loading — this is the
 * only test that runs inside workerd where console.createTask throws.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertStatus,
	createProjectHelpers,
	runBuild,
	scaffoldCloudflareProject,
	startDevServer,
	waitForServerReady,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-d1");
const helpers = createProjectHelpers(TEST_DIR);

describe("e2e: cloudflare d1", () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;

	beforeAll(async () => {
		await scaffoldCloudflareProject(TEST_DIR, helpers, PLUGIN_ROOT);
		await helpers.npx(["payload", "generate:importmap"]);

		server = await startDevServer(TEST_DIR, helpers);
		await waitForServerReady(server.proc, server.port, "/admin");
	});

	afterAll(async () => {
		await server?.kill();
	});

	// `assertStatus` throws on anything outside the allow-list, so it carries
	// the assertion — a further `toBeLessThan(500)` could never fail.
	it("admin UI loads in workerd without crashing", async () => {
		await assertStatus(server.port, "/admin", [200, 302, 307]);
	});

	it("admin API responds in workerd", async () => {
		await assertStatus(server.port, "/api/users", [200, 401, 403]);
	});

	it("production build succeeds", async () => {
		await runBuild(helpers);
	});
});
