/**
 * E2E test: Cloudflare D1 (workerd).
 *
 * Scaffolds a Payload project from the with-cloudflare-d1 template,
 * migrates to vinext, and verifies Payload works inside workerd.
 * Tests the admin UI to exercise React module loading — this is the
 * only test that runs inside workerd where console.createTask throws.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProjectHelpers,
	installVinextStack,
	rewritePayloadConfigForVinext,
	fixWranglerForLocalDev,
	assertStatus,
	runBuild,
	startDevServer,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-d1");
const helpers = createProjectHelpers(TEST_DIR);

async function scaffoldD1Project() {
	await helpers.cleanup();
	const { mkdir } = await import("node:fs/promises");
	await mkdir(TEST_DIR, { recursive: true });
	await helpers.npx([
		"--yes",
		"degit",
		"--force",
		"payloadcms/payload/templates/with-cloudflare-d1",
		TEST_DIR,
	]);

	await writeFile(join(TEST_DIR, ".env"), `PAYLOAD_SECRET=${crypto.randomUUID()}\n`);

	await installVinextStack(helpers, PLUGIN_ROOT);

	await rewritePayloadConfigForVinext(helpers);
	await fixWranglerForLocalDev(helpers);
}

describe("e2e: cloudflare d1", () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;

	beforeAll(async () => {
		await scaffoldD1Project();
		await helpers.npx(["vite-plugin-vinext-payload", "init"]);
		await helpers.npm(["install", "--legacy-peer-deps"]);
		await helpers.npx(["payload", "generate:importmap"]);

		server = await startDevServer(TEST_DIR, helpers);
	});

	afterAll(async () => {
		await server?.kill();
	});

	it("admin UI loads in workerd without crashing", async () => {
		const res = await assertStatus(server.port, "/admin", [200, 302, 307]);
		expect(res.status).toBeLessThan(500);
	});

	it("admin API responds in workerd", async () => {
		const res = await assertStatus(server.port, "/api/users", [200, 401, 403]);
		expect(res.status).toBeLessThan(500);
	});

	it("payload config uses getCloudflareEnv", async () => {
		const config = await helpers.read("src/payload.config.ts");
		expect(config).toContain("getCloudflareEnv");
		expect(config).not.toContain("@opennextjs/cloudflare");
	});

	it("init is idempotent", async () => {
		const output = await helpers.npx(["vite-plugin-vinext-payload", "init"]);
		expect(output).toContain("0 file(s) changed");
	});

	it("production build succeeds", async () => {
		await runBuild(helpers);
	});
});
