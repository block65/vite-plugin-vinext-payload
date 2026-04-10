/**
 * E2E test: Cloudflare D1.
 * Scaffolds a Payload project from the with-cloudflare-d1 template,
 * migrates to vinext, and verifies Payload works with Cloudflare Workers.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProjectHelpers,
	installVinextStack,
	rewritePayloadConfigForVinext,
	fixWranglerForLocalDev,
	runBuild,
	startDevServer,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-d1");
const helpers = createProjectHelpers(TEST_DIR);

async function scaffoldD1Project() {
	await helpers.cleanup();
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

	it("dev server responds to requests", async () => {
		// The Cloudflare plugin serves routes through workerd. Verify the
		// dev server is alive and processing requests (the root route may
		// 404 since the D1 template has no frontend page, but the server
		// must not crash).
		const res = await fetch(`http://localhost:${server.port}/`, {
			redirect: "manual",
		});
		// Any HTTP response (even 404) means the server is running.
		// 5xx would indicate a crash.
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
