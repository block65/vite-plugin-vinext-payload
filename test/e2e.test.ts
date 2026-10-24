/**
 * E2E test: SQLite (non-Cloudflare).
 * Scaffolds a Payload project from the postgres template, swaps to SQLite,
 * migrates to vinext, and verifies Payload works end-to-end — under
 * `vite dev`, and again from the production build served by `vinext start`.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertStatus,
	createProjectHelpers,
	runBuild,
	scaffoldSqliteProject,
	startDevServer,
	startProductionServer,
	waitForServerReady,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project");
const helpers = createProjectHelpers(TEST_DIR);

describe("e2e: sqlite", () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;

	beforeAll(async () => {
		await scaffoldSqliteProject(TEST_DIR, helpers, PLUGIN_ROOT);
		await helpers.npx(["payload", "generate:importmap"]);

		server = await startDevServer(TEST_DIR, helpers);
		await waitForServerReady(server.proc, server.port);
	});

	afterAll(async () => {
		await server?.kill();
	});

	it("frontend responds with 200", async () => {
		await assertStatus(server.port, "/", [200]);
	});

	it("admin redirects to create-first-user", async () => {
		// A redirect thrown after the shell flushed streams as a 200 whose
		// Flight payload carries the NEXT_REDIRECT digest the client follows,
		// as on Next.js 16; before the flush it is a 307
		const res = await assertStatus(server.port, "/admin", [200, 302, 307]);
		const digestTarget = (await res.text()).match(
			/NEXT_REDIRECT;[^;]*;([^;\\"]+)/,
		)?.[1];
		const target =
			res.status === 200
				? digestTarget && decodeURIComponent(digestTarget)
				: res.headers.get("location");
		expect(target).toMatch(/create-first-user|login/);
	});

	it("admin API responds", async () => {
		const res = await fetch(`http://localhost:${server.port}/api/users`, {
			redirect: "manual",
		});
		// 200 (empty list), 401/403 (auth required) — any means Payload is running
		expect([200, 401, 403]).toContain(res.status);
	});

	// The template's payload.config imports sharp, a native addon, at module
	// scope: every Payload request on the built server loads it
	describe("production build", () => {
		let production: Awaited<ReturnType<typeof startProductionServer>>;

		beforeAll(async () => {
			await runBuild(helpers);
			production = await startProductionServer(TEST_DIR, helpers);
			await waitForServerReady(production.proc, production.port);
		});

		afterAll(async () => {
			await production?.kill();
		});

		it("the built server serves the frontend", async () => {
			await assertStatus(production.port, "/", [200]);
		});

		it("the built server answers Payload API requests from the database", async () => {
			await assertStatus(production.port, "/api/users/init", [200]);
		});
	});
});
