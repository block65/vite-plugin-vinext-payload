/**
 * Drift detectors for the patches we apply to vinext's shipped `dist`.
 *
 * These patches match upstream source patterns. When vinext restructures,
 * a pattern stops matching and the patch becomes a silent no-op — the build
 * still succeeds, tests still pass, and the bug it prevented comes back
 * unnoticed. That is exactly what happened at the 0.1.3 -> 1.0.0-beta.2 bump:
 * three separate patches stopped applying and nothing failed.
 *
 * The existing unit tests use synthetic fixtures, so they cannot catch this.
 * These read the REAL installed vinext and assert each patch still finds its
 * target. A failure here means "re-verify this workaround against the new
 * vinext", not necessarily "the workaround is wrong".
 *
 * NB: vinext's `dist/index.js` is classified as binary by grep (`file`
 * reports `data`), so shell greps over it silently return nothing. Read it
 * from Node, as these tests do.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Locate the installed vinext by walking node_modules upward.
 *
 * `require.resolve("vinext")` and `require.resolve("vinext/package.json")`
 * both throw ERR_PACKAGE_PATH_NOT_EXPORTED — vinext's `exports` map makes
 * neither require-resolvable.
 *
 * Throws rather than skips when vinext is absent: it is auto-installed as a
 * peer via the lockfile in this repo, so absence means a broken install, and
 * a silent skip here would disable the entire point of this file.
 */
function findVinextDist(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", "vinext", "dist");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "vinext is not installed — drift detectors need the real package. Run `pnpm install`.",
      );
    }
    dir = parent;
  }
}

const dist = findVinextDist();

describe("vinext patch targets", () => {
  const read = (relative: string): string =>
    readFileSync(join(dist, relative), "utf-8");

  it("browser entry imports the navigation shim by relative path", () => {
    const code = read("server/app-browser-entry.js");
    // Anchored: 1.0 added sibling modules (navigation-context-state.js,
    // navigation-errors.js) that an unanchored match would hit first.
    expect(code).toMatch(/["'][^"']*shims\/navigation\.js["']/);
  });

  it("server-action commit function and dispatch both still exist", () => {
    const code = read("server/app-browser-navigation-controller.js");
    expect(code).toContain("commitSameUrlNavigatePayload");
    expect(code).toContain("dispatchSynchronousVisibleCommit");
  });

  it("RSC entry still default-exports an object with fetch", () => {
    const code = read("server/app-router-entry.js");
    expect(code).toMatch(/\{\s*async fetch\s*\(/);
  });
});
