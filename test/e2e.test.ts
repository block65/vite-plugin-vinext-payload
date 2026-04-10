/**
 * E2E test: SQLite (non-Cloudflare).
 * Scaffolds a Payload project from the postgres template, swaps to SQLite,
 * migrates to vinext, and verifies Payload works end-to-end.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertStatus,
	createProjectHelpers,
	installVinextStack,
	runBuild,
	startDevServer,
	VERSIONS,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project");
const helpers = createProjectHelpers(TEST_DIR);

async function scaffoldSqliteProject() {
	await helpers.cleanup();
	await mkdir(TEST_DIR, { recursive: true });
	await helpers.npx(["--yes", "degit", "--force", "payloadcms/payload/templates/with-postgres", TEST_DIR]);

	const pkg = JSON.parse(await helpers.read("package.json"));
	const payloadVersion = pkg.dependencies.payload || VERSIONS.payload;
	delete pkg.dependencies["@payloadcms/db-postgres"];
	pkg.dependencies["@payloadcms/db-sqlite"] = payloadVersion;
	delete pkg.devDependencies?.["@vitejs/plugin-react"];
	await writeFile(join(TEST_DIR, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

	const config = (await helpers.read("src/payload.config.ts"))
		.replace(
			"import { postgresAdapter } from '@payloadcms/db-postgres'",
			"import { sqliteAdapter } from '@payloadcms/db-sqlite'",
		)
		.replace(
			/db: postgresAdapter\(\{[\s\S]*?\}\),/,
			"db: sqliteAdapter({ client: { url: 'file:./data/payload.db' } }),",
		);
	await writeFile(join(TEST_DIR, "src/payload.config.ts"), config);
	await mkdir(join(TEST_DIR, "data"), { recursive: true });
	await writeFile(join(TEST_DIR, ".env"), `PAYLOAD_SECRET=${crypto.randomUUID()}\n`);

	await installVinextStack(helpers, PLUGIN_ROOT);
}

describe("e2e: sqlite", () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;

	beforeAll(async () => {
		await scaffoldSqliteProject();
		await helpers.npx(["vite-plugin-vinext-payload", "init"]);
		await helpers.npx(["payload", "generate:importmap"]);

		server = await startDevServer(TEST_DIR, helpers);
	});

	afterAll(async () => {
		await server?.kill();
	});

	it("frontend responds with 200", async () => {
		await assertStatus(server.port, "/", [200]);
	});

	it("admin redirects to create-first-user", async () => {
		const res = await assertStatus(server.port, "/admin", [200, 302, 307]);
		// If redirect, it should point to the login/create-first-user page
		if (res.status >= 300) {
			const location = res.headers.get("location") ?? "";
			expect(location).toMatch(/create-first-user|login/);
		}
	});

	it("admin API responds", async () => {
		// The REST API should be accessible
		const res = await fetch(`http://localhost:${server.port}/api/users`, {
			redirect: "manual",
		});
		// 200 (empty list), 401/403 (auth required) — any means Payload is running
		expect([200, 401, 403]).toContain(res.status);
	});

	it("production build succeeds", async () => {
		await runBuild(helpers);
	});
});
