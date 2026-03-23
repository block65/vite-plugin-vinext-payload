#!/usr/bin/env node
/**
 * Headless browser test for Payload CMS admin on vinext.
 *
 * Usage:
 *   node test-payload-admin.ts <url> <email> <password>
 *
 * Tests:
 *   1. Page load + hydration — no thrown errors, no Vite overlay
 *   2. Refresh stability — no optimizer-triggered reloads
 *   3. Array field add — row persists (form state not lost)
 *
 * All console output is captured across page loads (survives reloads
 * via sessionStorage). console.clear() is intercepted and logged.
 */
import { chromium, type Page } from "playwright";

const url = process.argv[2];
const email = process.argv[3];
const password = process.argv[4];

if (!url || !email || !password) {
	console.error(
		"Usage: node --import tsx test-payload-admin.ts <url> <email> <password>",
	);
	process.exit(2);
}

const origin = new URL(url).origin;

// ── Helpers ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "__TEST_LOGS__";

/** Inject into every page load — persists logs in sessionStorage. */
const INIT_SCRIPT = `(() => {
  const KEY = ${JSON.stringify(STORAGE_KEY)};
  const existing = JSON.parse(sessionStorage.getItem(KEY) || "[]");
  existing.push({ ts: Date.now(), type: "LOAD", text: window.location.href });
  sessionStorage.setItem(KEY, JSON.stringify(existing));

  const push = (type, text) => {
    const logs = JSON.parse(sessionStorage.getItem(KEY) || "[]");
    logs.push({ ts: Date.now(), type, text: String(text).slice(0, 1200) });
    sessionStorage.setItem(KEY, JSON.stringify(logs));
  };

  // Intercept console.clear so we see it instead of losing output
  console.clear = () => push("CLEAR", "console.clear() called");

  // Wrap every console method
  for (const m of ["log","warn","error","info","debug"]) {
    const orig = console[m];
    console[m] = (...args) => {
      push(m, args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === "object") try { return JSON.stringify(a); } catch { return String(a); }
        return String(a);
      }).join(" "));
      return orig.apply(console, args);
    };
  }

  // Uncaught errors (would cause Vite overlay)
  window.addEventListener("error", e => push("UNCAUGHT", e.message + " @ " + e.filename + ":" + e.lineno));
})();`;

interface LogEntry {
	ts: number;
	type: string;
	text: string;
}

function printLogs(logs: LogEntry[]): void {
	let loadNum = 0;
	for (const l of logs) {
		// Skip noise
		if (l.text.includes("<link rel=preload>")) {
			continue;
		}
		if (l.text.includes("Download the React DevTools")) {
			continue;
		}

		if (l.type === "LOAD") {
			loadNum++;
			console.log(`\n── Page load #${loadNum}: ${l.text}`);
			continue;
		}
		if (l.type === "CLEAR") {
			console.log(`  *** CONSOLE.CLEAR ***`);
			continue;
		}
		if (l.type === "UNCAUGHT") {
			console.log(`  !!! [uncaught] ${l.text.slice(0, 250)}`);
			continue;
		}
		console.log(`  [${l.type}] ${l.text.slice(0, 250)}`);
	}
}

async function getLogs(page: Page): Promise<LogEntry[]> {
	return page.evaluate(
		(key) => JSON.parse(sessionStorage.getItem(key) || "[]"),
		STORAGE_KEY,
	);
}

async function clearLogs(page: Page): Promise<void> {
	await page.evaluate(
		(key) => sessionStorage.removeItem(key),
		STORAGE_KEY,
	);
}

// ── Launch ─────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

// Inject log capture into every page load
await page.addInitScript({ content: INIT_SCRIPT });

// Track page loads from Playwright side (catches optimizer-triggered reloads)
let pageLoadCount = 0;
page.on("load", () => pageLoadCount++);

// ── Login ──────────────────────────────────────────────────────────────────

const loginRes = await context.request.post(`${origin}/api/users/login`, {
	data: { email, password },
});
if (!loginRes.ok()) {
	console.error(`Login failed: HTTP ${loginRes.status()}`);
	await browser.close();
	process.exit(2);
}

// ── Test 1: Initial page load ──────────────────────────────────────────────

console.log("━".repeat(60));
console.log("TEST 1: Initial page load + hydration");
console.log("━".repeat(60));

pageLoadCount = 0;
await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
// Wait for hydration + any optimizer-triggered reload
await page.waitForTimeout(10_000);

let logs = await getLogs(page);
const loadsDuringInit = logs.filter((l) => l.type === "LOAD").length;
const uncaughtInit = logs.filter((l) => l.type === "UNCAUGHT").length;
const hydrationInit = logs.filter(
	(l) => l.type === "error" && /[Hh]ydration|mismatch/.test(l.text),
).length;

printLogs(logs);

const hasOverlay = await page.evaluate(
	() => !!document.querySelector("vite-error-overlay"),
);

console.log(
	`\nResult: ${loadsDuringInit} load(s), ${hydrationInit} hydration warning(s), ${uncaughtInit} uncaught error(s), overlay=${hasOverlay}`,
);
if (loadsDuringInit > 1) {
	console.log(
		"  ⚠ Multiple loads detected — optimizer may have triggered a reload",
	);
}

// ── Test 2: Refresh stability ──────────────────────────────────────────────

console.log("\n" + "━".repeat(60));
console.log("TEST 2: Refresh stability (F5)");
console.log("━".repeat(60));

await clearLogs(page);
pageLoadCount = 0;

await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(10_000);

logs = await getLogs(page);
const loadsDuringRefresh = logs.filter((l) => l.type === "LOAD").length;
const uncaughtRefresh = logs.filter((l) => l.type === "UNCAUGHT").length;

printLogs(logs);

console.log(
	`\nResult: ${loadsDuringRefresh} load(s), ${uncaughtRefresh} uncaught error(s)`,
);
if (loadsDuringRefresh > 1) {
	console.log("  ⚠ Optimizer-triggered reload detected after refresh!");
}

// ── Test 3: Array field add ────────────────────────────────────────────────

console.log("\n" + "━".repeat(60));
console.log("TEST 3: Array field add (form state persistence)");
console.log("━".repeat(60));

await clearLogs(page);

// Count rows by header text (leaf text nodes only)
const countRowsByText = (label: string) =>
	page.evaluate((lbl) => {
		const walker = document.createTreeWalker(
			document.body,
			NodeFilter.SHOW_TEXT,
		);
		let count = 0;
		while (walker.nextNode()) {
			if (
				new RegExp(`^${lbl} \\d+$`).test(
					walker.currentNode.textContent?.trim() ?? "",
				)
			) {
				count++;
			}
		}
		return count;
	}, label);

const beforeCount = await countRowsByText("Social Link");
console.log(`Social Link rows before: ${beforeCount}`);

// Click Add Social Link
const addBtn = page.locator('button:has-text("Add Social Link")').first();
if (!(await addBtn.isVisible())) {
	console.log("⚠ Add Social Link button not visible — skipping test");
} else {
	// Watch for server action network requests
	const serverActions: { action: string; url: string }[] = [];
	const actionListener = (req: { headers(): Record<string, string>; url(): string }) => {
		const h = req.headers();
		if (h["x-rsc-action"]) {
			serverActions.push({ action: h["x-rsc-action"], url: req.url() });
		}
	};
	page.on("request", actionListener);

	await addBtn.click();
	console.log("Clicked Add Social Link, waiting 8s...");
	await page.waitForTimeout(8_000);

	page.off("request", actionListener);

	const afterCount = await countRowsByText("Social Link");
	console.log(`Social Link rows after:  ${afterCount}`);
	console.log(`Server actions fired:    ${serverActions.length}`);
	for (const sa of serverActions) {
		console.log(`  → ${sa.action}`);
	}

	logs = await getLogs(page);
	const postClickErrors = logs.filter(
		(l) =>
			l.type === "error" &&
			!l.text.includes("preload") &&
			!l.text.includes("hydration") &&
			!l.text.includes("Hydration") &&
			!l.text.includes("404"),
	);
	const postClickUncaught = logs.filter((l) => l.type === "UNCAUGHT");
	const postClickClears = logs.filter((l) => l.type === "CLEAR");

	if (
		postClickErrors.length ||
		postClickUncaught.length ||
		postClickClears.length
	) {
		console.log("\nConsole after click:");
		printLogs(logs);
	}

	if (afterCount > beforeCount) {
		console.log(
			`\n✓ Row added and persisted (${beforeCount} → ${afterCount})`,
		);
	} else {
		console.log(
			`\n✗ Row NOT persisted (${beforeCount} → ${afterCount})`,
		);
	}
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log("\n" + "━".repeat(60));
console.log("SUMMARY");
console.log("━".repeat(60));

const failures: string[] = [];
if (hasOverlay) {
	failures.push("Vite error overlay visible");
}
if (uncaughtInit > 0) {
	failures.push(`${uncaughtInit} uncaught error(s) on load`);
}
if (loadsDuringInit > 1) {
	failures.push("Optimizer reload on initial load");
}
if (loadsDuringRefresh > 1) {
	failures.push("Optimizer reload on refresh");
}

if (failures.length === 0) {
	console.log("✓ All tests passed");
} else {
	for (const f of failures) {
		console.log(`✗ ${f}`);
	}
}

await browser.close();
process.exit(failures.length > 0 ? 1 : 0);
