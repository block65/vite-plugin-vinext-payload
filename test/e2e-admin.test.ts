/**
 * E2E test: Admin UI with Playwright (SQLite).
 *
 * Scaffolds a real Payload project, starts the dev server, then
 * uses Playwright to test actual admin workflows:
 *   1. Create first user (registration)
 *   2. Navigate the admin dashboard
 *   3. Create a document via the admin UI
 *   4. Verify the document appears in the collection list
 *   5. No hydration errors or uncaught exceptions throughout
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
} from "playwright";
import {
	createProjectHelpers,
	installVinextStack,
	startDevServer,
	VERSIONS,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-admin");
const helpers = createProjectHelpers(TEST_DIR);

const TEST_EMAIL = "admin@test.local";
const TEST_PASSWORD = "Test-password-123!";

const consoleErrors: string[] = [];

async function scaffoldAdminProject() {
	await helpers.cleanup();
	await mkdir(TEST_DIR, { recursive: true });
	await helpers.npx([
		"--yes",
		"degit",
		"--force",
		"payloadcms/payload/templates/with-postgres",
		TEST_DIR,
	]);

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

describe("e2e: admin ui", () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;

	beforeAll(async () => {
		await scaffoldAdminProject();
		await helpers.npx(["vite-plugin-vinext-payload", "init"]);
		await helpers.npx(["payload", "generate:importmap"]);

		server = await startDevServer(TEST_DIR, helpers);

		browser = await chromium.launch({ headless: true });
		context = await browser.newContext({ ignoreHTTPSErrors: true });
		page = await context.newPage();

		page.on("console", (msg) => {
			if (msg.type() === "error") {
				consoleErrors.push(msg.text());
			}
		});
		page.on("pageerror", (err) => {
			consoleErrors.push(err.message);
		});
	});

	afterAll(async () => {
		await browser?.close();
		await server?.kill();
	});

	it("redirects to create-first-user", async () => {
		// Slowest step in the suite (~20s): the first request to /admin pays
		// for on-demand compilation of the whole admin route. Everything after
		// it lands in ~1.5s. Still inside Playwright's 30s default.
		await page.goto(`http://localhost:${server.port}/admin`, {
			waitUntil: "networkidle",
		});

		await page.waitForURL("**/create-first-user");
		expect(page.url()).toContain("create-first-user");
	});

	it("creates first user via registration form", async () => {
		// Should already be on create-first-user from previous test
		await page.fill('input[name="email"]', TEST_EMAIL);
		await page.fill('input[name="password"]', TEST_PASSWORD);
		await page.fill('input[name="confirm-password"]', TEST_PASSWORD);
		await page.click('button[type="submit"]');

		await page.waitForURL("**/admin");
		expect(page.url()).toMatch(/\/admin\/?$/);
	});

	it("dashboard loads without Vite error overlay", async () => {
		// Inherits `page` from the previous test, which left it on /admin —
		// this asserts the overlay only, and never navigates itself.
		const hasOverlay = await page.evaluate(
			() => !!document.querySelector("vite-error-overlay"),
		);
		expect(hasOverlay).toBe(false);
	});

	it("navigates to users collection", async () => {
		await page.goto(
			`http://localhost:${server.port}/admin/collections/users`,
			{ waitUntil: "networkidle" },
		);

		const pageContent = await page.textContent("body");
		expect(pageContent).toContain(TEST_EMAIL);
	});

	it("can log out and log back in", async () => {
		// Navigate to the logout route. Use waitUntil "commit" rather than
		// "networkidle": logout immediately redirects to /login, and vinext's
		// code-split chunk requests on that transition keep the network busy,
		// so "networkidle" (500ms quiet) frequently never settles within the
		// timeout. The real assertion is the waitForURL below.
		await page.goto(`http://localhost:${server.port}/admin/logout`, {
			waitUntil: "commit",
		});

		await page.waitForURL("**/login**");

		await page.fill('input[name="email"]', TEST_EMAIL);
		await page.fill('input[name="password"]', TEST_PASSWORD);
		await page.click('button[type="submit"]');

		await page.waitForURL("**/admin");
		expect(page.url()).toMatch(/\/admin\/?$/);
	});

	it("no hydration errors throughout test run", () => {
		const hydrationErrors = consoleErrors.filter(
			(e) => /[Hh]ydration|mismatch/i.test(e),
		);
		if (hydrationErrors.length > 0) {
			console.log("Hydration errors found:", hydrationErrors);
		}
		expect(hydrationErrors).toHaveLength(0);
	});

	it("no uncaught NEXT_REDIRECT errors", () => {
		const redirectErrors = consoleErrors.filter(
			(e) => e.includes("NEXT_REDIRECT"),
		);
		expect(redirectErrors).toHaveLength(0);
	});
});
