/**
 * E2E test: Cloudflare D1 (workerd).
 *
 * Scaffolds a Payload project from the with-cloudflare-d1 template,
 * migrates to vinext, and verifies Payload works inside workerd — under
 * `vite dev`, and again from the production build served by `vite preview`.
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
	startPreviewServer,
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

	// `/init` queries the users table with no access check, so only a pushed
	// schema answers 200; `/api/users` refuses anonymous reads before any query
	it("Payload pushes its dev schema to D1", async () => {
		await assertStatus(server.port, "/api/users/init", [200]);
	});

	describe("production build", () => {
		let preview: Awaited<ReturnType<typeof startPreviewServer>>;

		beforeAll(async () => {
			await runBuild(helpers);
			preview = await startPreviewServer(TEST_DIR, helpers);
			await waitForServerReady(preview.proc, preview.port, "/admin");
		});

		afterAll(async () => {
			await preview?.kill();
		});

		it("the built Worker serves the admin UI", async () => {
			await assertStatus(preview.port, "/admin", [200, 302, 307]);
		});

		it("the built Worker serves the admin API", async () => {
			await assertStatus(preview.port, "/api/users", [200, 401, 403]);
		});
	});
});
