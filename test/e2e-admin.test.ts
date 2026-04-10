/**
 * E2E test: Admin UI (SQLite).
 *
 * Scaffolds a Payload project from the postgres template (swapped to
 * SQLite), migrates to vinext, runs init, starts the dev server, then
 * uses Playwright to verify:
 *   1. No hydration errors, no Vite overlay, no uncaught errors
 *   2. Refresh doesn't trigger optimizer reload
 *   3. No hydration mismatches on collection pages
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
} from "playwright";
import {
	createProjectHelpers,
	installVinextStack,
	runBuild,
	startDevServer,
	VERSIONS,
} from "./helpers.ts";
import {
	INIT_SCRIPT,
	getLogs,
	clearLogs,
	printLogs,
} from "./playwright-helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-admin");
const helpers = createProjectHelpers(TEST_DIR);

const TEST_EMAIL = "admin@test.local";
const TEST_PASSWORD = "Test-password-123!";

async function scaffoldAdminProject() {
	await helpers.cleanup();
	await mkdir(TEST_DIR, { recursive: true });
	await helpers.npx([
		"--yes",
		"degit",
		"payloadcms/payload/templates/with-postgres",
		TEST_DIR,
	]);

	// Swap postgres → sqlite, remove @vitejs/plugin-react (conflicts with Vite 8)
	const pkg = JSON.parse(await helpers.read("package.json"));
	const payloadVersion = pkg.dependencies.payload || VERSIONS.payload;
	delete pkg.dependencies["@payloadcms/db-postgres"];
	pkg.dependencies["@payloadcms/db-sqlite"] = payloadVersion;
	delete pkg.devDependencies?.["@vitejs/plugin-react"];
	await writeFile(
		join(TEST_DIR, "package.json"),
		JSON.stringify(pkg, null, 2) + "\n",
	);

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

	await writeFile(
		join(TEST_DIR, ".env"),
		`PAYLOAD_SECRET=${crypto.randomUUID()}\n`,
	);

	await installVinextStack(helpers, PLUGIN_ROOT);
}

/** Create first user via the admin UI registration form. */
async function createFirstUserViaUI(page: Page, port: number) {
	await page.goto(`http://localhost:${port}/admin`, {
		waitUntil: "networkidle",
		timeout: 60_000,
	});

	// Payload redirects to /admin/create-first-user when no users exist
	await page.waitForURL("**/create-first-user", { timeout: 15_000 });

	await page.fill('input[name="email"]', TEST_EMAIL);
	await page.fill('input[name="password"]', TEST_PASSWORD);
	await page.fill('input[name="confirm-password"]', TEST_PASSWORD);
	await page.click('button[type="submit"]');

	// Wait for redirect to dashboard after successful creation
	await page.waitForURL("**/admin", { timeout: 30_000 });
}

describe("e2e: admin ui (sqlite)", { timeout: 600_000 }, () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;

	before(async () => {
		await scaffoldAdminProject();

		const output = await helpers.npx([
			"vite-plugin-vinext-payload",
			"init",
		]);
		console.log(output);

		await helpers.npx(["payload", "generate:importmap"]);

		server = await startDevServer(TEST_DIR, helpers);
		await sleep(5000);

		browser = await chromium.launch({ headless: true });
		context = await browser.newContext({ ignoreHTTPSErrors: true });
		page = await context.newPage();
		await page.addInitScript({ content: INIT_SCRIPT });

		// Create first user via the admin UI
		await createFirstUserViaUI(page, server.port);
		await clearLogs(page);
	});

	after(async () => {
		await browser?.close();
		await server?.[Symbol.asyncDispose]();
	});

	it("loads admin without errors or overlay", async () => {
		await page.goto(`http://localhost:${server.port}/admin`, {
			waitUntil: "networkidle",
			timeout: 60_000,
		});
		await page.waitForTimeout(10_000);

		const logs = await getLogs(page);
		const loads = logs.filter((l) => l.type === "LOAD");
		const uncaught = logs.filter((l) => l.type === "UNCAUGHT");

		printLogs(logs);

		const hasOverlay = await page.evaluate(
			() => !!document.querySelector("vite-error-overlay"),
		);

		assert.equal(hasOverlay, false, "Vite error overlay should not be visible");
		assert.equal(uncaught.length, 0, `Uncaught errors: ${uncaught.map((e) => e.text).join(", ")}`);
		assert.equal(loads.length, 1, `Expected 1 page load, got ${loads.length} (optimizer reload?)`);
	});

	it("refresh does not trigger optimizer reload", async () => {
		await clearLogs(page);

		await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
		await page.waitForTimeout(10_000);

		const logs = await getLogs(page);
		const loads = logs.filter((l) => l.type === "LOAD");
		const uncaught = logs.filter((l) => l.type === "UNCAUGHT");

		assert.equal(loads.length, 1, `Expected 1 load after refresh, got ${loads.length}`);
		assert.equal(uncaught.length, 0, `Uncaught errors after refresh: ${uncaught.map((e) => e.text).join(", ")}`);
	});

	it("no hydration mismatches on collection page", async () => {
		// Navigate to a collection page (users should always exist)
		await page.goto(
			`http://localhost:${server.port}/admin/collections/users`,
			{ waitUntil: "networkidle", timeout: 60_000 },
		);
		await page.waitForTimeout(5_000);

		const logs = await getLogs(page);
		const hydration = logs.filter(
			(l) =>
				l.type === "error" &&
				/[Hh]ydration|mismatch/.test(l.text),
		);
		const uncaught = logs.filter((l) => l.type === "UNCAUGHT");

		if (hydration.length > 0 || uncaught.length > 0) {
			printLogs(logs);
		}

		assert.equal(
			hydration.length,
			0,
			`Hydration errors on collection page: ${hydration.length}`,
		);
		assert.equal(
			uncaught.length,
			0,
			`Uncaught errors: ${uncaught.map((e) => e.text).join(", ")}`,
		);
	});

	it("production build succeeds", async () => {
		await runBuild(helpers);
	});
});
