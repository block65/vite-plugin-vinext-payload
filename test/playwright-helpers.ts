/**
 * Playwright helpers for admin UI e2e tests.
 *
 * Injects a log-capture script via sessionStorage that survives page
 * reloads. Intercepts console.clear() so optimizer-triggered reloads
 * don't hide errors.
 */
import type { Page } from "playwright";

const STORAGE_KEY = "__TEST_LOGS__";

/** Injected into every page load via addInitScript. */
export const INIT_SCRIPT = `(() => {
  const KEY = ${JSON.stringify(STORAGE_KEY)};
  const existing = JSON.parse(sessionStorage.getItem(KEY) || "[]");
  existing.push({ ts: Date.now(), type: "LOAD", text: window.location.href });
  sessionStorage.setItem(KEY, JSON.stringify(existing));

  const push = (type, text) => {
    const logs = JSON.parse(sessionStorage.getItem(KEY) || "[]");
    logs.push({ ts: Date.now(), type, text: String(text).slice(0, 1200) });
    sessionStorage.setItem(KEY, JSON.stringify(logs));
  };

  console.clear = () => push("CLEAR", "console.clear() called");

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

  window.addEventListener("error", e => push("UNCAUGHT", e.message + " @ " + e.filename + ":" + e.lineno));
})();`;

export interface LogEntry {
	ts: number;
	type: string;
	text: string;
}

export async function getLogs(page: Page): Promise<LogEntry[]> {
	return page.evaluate(
		(key) => JSON.parse(sessionStorage.getItem(key) || "[]"),
		STORAGE_KEY,
	);
}

export async function clearLogs(page: Page): Promise<void> {
	await page.evaluate(
		(key) => sessionStorage.removeItem(key),
		STORAGE_KEY,
	);
}

export function printLogs(logs: LogEntry[]): void {
	let loadNum = 0;
	for (const l of logs) {
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
