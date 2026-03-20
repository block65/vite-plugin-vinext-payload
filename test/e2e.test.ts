/**
 * E2E test: SQLite (non-Cloudflare) migration.
 * Scaffolds a Payload project from the postgres template, swaps to SQLite,
 * migrates to vinext, runs init, starts the dev server, asserts routes.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	createProjectHelpers,
	installVinextStack,
	waitForOutput,
	VERSIONS,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project");
const helpers = createProjectHelpers(TEST_DIR);

async function assertStatus(port: number, path: string, expected: number[]) {
	const res = await fetch(`http://localhost:${port}${path}`, { redirect: "manual" });
	assert.ok(
		expected.includes(res.status),
		`GET ${path} expected ${expected.join("|")}, got ${res.status}`,
	);
}

async function scaffoldSqliteProject() {
	await helpers.cleanup();
	await mkdir(TEST_DIR, { recursive: true });
	await helpers.npx(["--yes", "degit", "payloadcms/payload/templates/with-postgres", TEST_DIR]);

	// Swap postgres → sqlite
	const pkg = JSON.parse(await helpers.read("package.json"));
	delete pkg.dependencies["@payloadcms/db-postgres"];
	pkg.dependencies["@payloadcms/db-sqlite"] = VERSIONS.payload;
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

describe("e2e: sqlite migration", { timeout: 600_000 }, () => {
	let server: ChildProcess | null = null;

	before(async () => {
		await scaffoldSqliteProject();

		const output = await helpers.npx(["vite-plugin-vinext-payload", "init"]);
		console.log(output);

		await helpers.npx(["payload", "generate:importmap"]);
	});

	after(async () => {
		server?.kill("SIGTERM");
		await sleep(1000);
		server?.kill("SIGKILL");
		server = null;
		await helpers.cleanup();
	});

	it("creates serverFunction.ts", async () => {
		assert.ok(await helpers.exists("src/app/(payload)/serverFunction.ts"));
	});

	it("adds payloadPlugin to vite.config.ts", async () => {
		const config = await helpers.read("vite.config.ts");
		assert.ok(config.includes("payloadPlugin"));
		assert.ok(config.includes("vite-plugin-vinext-payload"));
	});

	it("adds normalizeParams to page.tsx", async () => {
		const page = await helpers.read("src/app/(payload)/admin/[[...segments]]/page.tsx");
		assert.ok(page.includes("normalizeParams"));
	});

	it("is idempotent", async () => {
		const output = await helpers.npx(["vite-plugin-vinext-payload", "init"]);
		assert.ok(output.includes("0 file(s) changed"));
	});

	it("dev server responds on / and /admin", async () => {
		const pkg = JSON.parse(await helpers.read("package.json"));
		const script = pkg.scripts["dev:vinext"] ? "dev:vinext" : "dev";

		server = spawn("npm", ["run", script], {
			cwd: TEST_DIR,
			stdio: "pipe",
			env: { ...process.env, NODE_ENV: "development" },
		});

		const match = await waitForOutput(server, /localhost:(\d+)/);
		const port = Number.parseInt(match[1], 10);

		await sleep(5000);

		await assertStatus(port, "/", [200]);
		await assertStatus(port, "/admin", [200, 302, 307]);
	});
});
