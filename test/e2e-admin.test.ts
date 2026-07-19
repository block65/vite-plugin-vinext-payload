/**
 * E2E test: Payload admin UI with Playwright (SQLite).
 *
 * Scaffolds a real Payload project, starts the dev server, then drives the
 * admin panel the way an administrator does — entering at the site root and
 * clicking through:
 *   1. First run: create the initial admin user, land on the dashboard
 *   2. Sign in and find that account in the Users collection
 *   3. Sign out and sign back in
 * Every journey also proves the page rendered without a Vite error overlay
 * and without hydration / NEXT_REDIRECT runtime errors.
 *
 * ── Deviations from agent-standards/engineering/playwright.md ──
 *
 * The standard assumes the `@playwright/test` runner. This suite runs under
 * vitest (the runner owns the scaffold + dev-server lifecycle), so two of its
 * APIs are unavailable and are replaced with the closest equivalent:
 *
 *   - `test.step()`      → the local `step()` helper below. Same purpose:
 *                          name the arrange/act/assert phases so a failure
 *                          says which phase broke. Never `console.log`.
 *   - `expect(locator)`  → `locator.waitFor()` via `visible()` / `gone()`.
 *                          These are Playwright's own auto-waiting, retrying
 *                          primitives — vitest's `expect` has no web-first
 *                          locator assertions, and a non-retrying
 *                          `expect(await x.isVisible())` is banned.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Locator,
	type Page,
} from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProjectHelpers,
	installVinextStack,
	startDevServer,
	waitForServerReady,
	VERSIONS,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-admin");
const helpers = createProjectHelpers(TEST_DIR);

type Credentials = { email: string; password: string };

/**
 * Name a phase of a test so a failure reports which phase broke.
 *
 * Stand-in for `test.step()`, which only exists in the `@playwright/test`
 * runner. See the deviations note at the top of this file.
 */
async function step<T>(name: string, body: () => Promise<T>): Promise<T> {
	try {
		return await body();
	} catch (error) {
		throw new Error(`step "${name}" failed`, { cause: error });
	}
}

/** Web-first: retries until the element is visible, fails the test otherwise. */
function visible(locator: Locator) {
	return locator.waitFor({ state: "visible" });
}

/** Web-first: retries until the element is absent or hidden. */
function gone(locator: Locator) {
	return locator.waitFor({ state: "hidden" });
}

/**
 * Fail the journey if the browser reported a hydration mismatch or an
 * uncaught NEXT_REDIRECT — the two failure modes this plugin exists to
 * prevent. The offending messages go in the assertion message so a failure
 * is reproducible without re-running.
 */
function assertNoRuntimeErrors(runtimeErrors: readonly string[]) {
	const hydration = runtimeErrors.filter((message) =>
		/[Hh]ydration|mismatch/i.test(message),
	);
	expect(hydration, `hydration errors: ${JSON.stringify(hydration)}`).toEqual(
		[],
	);

	const redirects = runtimeErrors.filter((message) =>
		message.includes("NEXT_REDIRECT"),
	);
	expect(
		redirects,
		`uncaught NEXT_REDIRECT errors: ${JSON.stringify(redirects)}`,
	).toEqual([]);
}

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

	/**
	 * The initial admin, created lazily on first use.
	 *
	 * Payload's "create first user" screen is a property of an empty database,
	 * not of a test: it can be exercised exactly once per scaffold. Memoising
	 * it here means whichever test runs first performs the real registration
	 * journey and the rest sign in — so every test below is runnable on its
	 * own, in any subset, without depending on another test having run.
	 */
	let initialAdmin: Promise<Credentials> | undefined;

	/**
	 * A fresh browser context per journey: its own cookies, its own storage,
	 * its own collected runtime errors. Nothing is shared between tests but
	 * the (immutable) dev server and browser binary.
	 */
	async function newSession() {
		const context = await browser.newContext({
			baseURL: `http://localhost:${server.port}`,
			ignoreHTTPSErrors: true,
		});
		const runtimeErrors: string[] = [];
		context.on("page", (opened) => {
			opened.on("console", (message) => {
				if (message.type() === "error") {
					runtimeErrors.push(message.text());
				}
			});
			opened.on("pageerror", (error) => {
				runtimeErrors.push(error.message);
			});
		});
		return { context, runtimeErrors };
	}

	/**
	 * Enter the app the way an administrator does: open the site, click
	 * through to the admin panel. The template's link is `target="_blank"`,
	 * so the panel genuinely opens in a new tab — that tab is what we drive.
	 */
	async function openAdminPanel(context: BrowserContext): Promise<Page> {
		const home = await context.newPage();
		await home.goto("/");

		const adminTab = context.waitForEvent("page");
		await home.getByRole("link", { name: "Go to admin panel" }).click();
		return adminTab;
	}

	/**
	 * Open the collections nav, the way an admin on a laptop does.
	 *
	 * Payload pins the nav open only above its large breakpoint; below it the
	 * nav renders in the layout but the main content paints over it, so its
	 * links are present and visible yet nothing can reach them. Every nav link
	 * has to go through here. The button reports its own state in its label —
	 * "Open Menu" only exists while the nav is closed — so this is a no-op on a
	 * viewport wide enough to pin it.
	 */
	async function openNav(page: Page) {
		// Wait for the toggler rather than probing for it: sign-in returns
		// before the authenticated layout renders, so a presence check here
		// finds nothing and silently concludes the nav is already open.
		const toggle = page.getByRole("button", { name: /(open|close) menu/i });
		await toggle.waitFor();

		const label = (await toggle.getAttribute("aria-label")) ?? "";
		if (/open menu/i.test(label)) {
			await toggle.click();
			// The button renames itself once the nav is open, which is the
			// state change to wait on — clicking a link mid-animation is still
			// a click into the content that covers it.
			await visible(page.getByRole("button", { name: /close menu/i }));
		}
	}

	/** Sign in through the login form, the way an admin does. */
	async function signIn(page: Page, credentials: Credentials) {
		await page.getByLabel("Email").fill(credentials.email);
		await page.getByLabel("Password").fill(credentials.password);
		await page.getByRole("button", { name: "Login" }).click();
	}

	/**
	 * Register the very first admin through the create-first-user screen.
	 *
	 * Deliberately a full journey with its own assertions rather than a silent
	 * fixture: it is the body of the first test, factored out only so the
	 * later tests can trigger it when they are run in isolation.
	 */
	async function createInitialAdmin(): Promise<Credentials> {
		const credentials: Credentials = {
			email: `qa-${crypto.randomUUID()}@example.test`,
			password: `Qa-${crypto.randomUUID()}!`,
		};

		const { context, runtimeErrors } = await newSession();
		const admin = await openAdminPanel(context);

		// The first request to /admin compiles the whole admin route on
		// demand (~20s). It stays inside Playwright's default budget; if it
		// stops doing so that is a regression, not a timeout to raise.
		await admin.getByLabel("Email").fill(credentials.email);
		await admin.getByLabel("New Password").fill(credentials.password);
		await admin.getByLabel("Confirm Password").fill(credentials.password);
		await admin.getByRole("button", { name: "Create" }).click();

		// Terminal: the sign-out control only exists for an authenticated
		// admin, so its presence is the dashboard rendering *and* the
		// registration succeeding.
		await visible(admin.getByRole("link", { name: /log ?out/i }));
		// `vite-error-overlay` is Vite's own dev-tooling custom element, not
		// product markup — there is no role or testid to reach it by.
		await gone(admin.locator("vite-error-overlay"));
		assertNoRuntimeErrors(runtimeErrors);

		await context.close();
		return credentials;
	}

	function initialAdminCredentials() {
		initialAdmin ??= createInitialAdmin();
		return initialAdmin;
	}

	beforeAll(async () => {
		await scaffoldAdminProject();
		await helpers.npx(["vite-plugin-vinext-payload", "init"]);
		await helpers.npx(["payload", "generate:importmap"]);

		server = await startDevServer(TEST_DIR, helpers);

		// Compile /admin before any browser action measures it. This is the
		// only suite that skipped this, so its first Playwright call absorbed
		// the whole cold build of the heaviest route in the repo inside a 30s
		// per-action budget — passing or failing on which side of 30s the
		// build happened to land.
		await waitForServerReady(server.proc, server.port, "/admin");

		browser = await chromium.launch({ headless: true });
	});

	afterAll(async () => {
		await browser?.close();
		await server?.kill();
	});

	it("a first-time visitor registers the initial admin and reaches the dashboard", async () => {
		await step(
			"register the first admin from the site's admin link",
			async () => {
				await initialAdminCredentials();
			},
		);
	});

	it("an admin can sign in and find their account in the users collection", async () => {
		const credentials = await step("ensure an admin account exists", () =>
			initialAdminCredentials(),
		);

		const { context, runtimeErrors } = await newSession();

		await step("sign in from the site's admin link", async () => {
			const admin = await openAdminPanel(context);
			await signIn(admin, credentials);

			// No page-identity assertion — the nav link click below cannot
			// resolve unless the dashboard rendered for a signed-in admin.
			await openNav(admin);
			await admin.getByRole("link", { name: "Users", exact: true }).click();

			// Terminal: the admin came to see their own account listed.
			await visible(
				admin.getByRole("row").filter({ hasText: credentials.email }),
			);
			await gone(admin.locator("vite-error-overlay"));
		});

		await step("the session produced no runtime errors", async () => {
			assertNoRuntimeErrors(runtimeErrors);
			await context.close();
		});
	});

	it("an admin who signs out can sign back in", async () => {
		const credentials = await step("ensure an admin account exists", () =>
			initialAdminCredentials(),
		);

		const { context, runtimeErrors } = await newSession();

		await step("sign in, sign out, sign back in", async () => {
			const admin = await openAdminPanel(context);
			await signIn(admin, credentials);

			await openNav(admin);
			await admin.getByRole("link", { name: /log ?out/i }).click();

			// No assertion that we left — filling the login form below cannot
			// happen unless sign-out landed the admin back on the login page.
			await signIn(admin, credentials);

			// Terminal: the sign-out control is back, so the second sign-in
			// produced an authenticated dashboard.
			await visible(admin.getByRole("link", { name: /log ?out/i }));
			await gone(admin.locator("vite-error-overlay"));
		});

		await step("the session produced no runtime errors", async () => {
			assertNoRuntimeErrors(runtimeErrors);
			await context.close();
		});
	});
});
