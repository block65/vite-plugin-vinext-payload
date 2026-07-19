/**
 * Unit tests for `payloadServerActionFix`.
 *
 * Regression coverage for the form-state-revert / RSC-loop bug:
 * vinext ≥0.0.47 moved `commitSameUrlNavigatePayload` from
 * `app-browser-entry` into `app-browser-navigation-controller` and
 * unconditionally calls a visible-commit dispatcher before returning the
 * action's data — `dispatchApprovedVisibleCommit` in 0.0.47–0.0.49,
 * renamed to `dispatchSynchronousVisibleCommit` in 0.0.50. For Payload's
 * `getFormState` (data-only action via `useActionState`), that re-applies
 * a stale RSC tree and resets the form via REPLACE_STATE — observed as
 * dropdowns reverting on blur and an infinite loop of RSC requests.
 *
 * The transform gates the dispatch on `!returnValue`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { payloadServerActionFix } from "../src/server-action-fix.ts";

const CONTROLLER_PATH =
	"/node_modules/vinext/dist/server/app-browser-navigation-controller.js";

function callTransform(plugin: Plugin, code: string, id: string) {
	const hook = plugin.transform;
	if (typeof hook !== "function") {
		throw new Error("expected plugin.transform to be a function");
	}
	return hook.call({} as never, code, id);
}

// Minified-ish fixture that mirrors the shape of the real vinext 0.0.49
// `commitSameUrlNavigatePayload` body. Keep this in sync with the real file
// if vinext restructures the function (the test against the installed file
// below will catch drift).
const CONTROLLER_FIXTURE = `
function createAppBrowserNavigationController(deps) {
	function dispatchApprovedVisibleCommit(commit, pendingRouterState, useTransitionMode) {}
	async function commitSameUrlNavigatePayload(nextElements, navigationSnapshot, returnValue, actionInitiationState) {
		const currentState = actionInitiationState ?? getBrowserRouterState();
		const startedNavigationId = activeNavigationId;
		const { approvedCommit, decision, pending } = await resolveAndClassifyNavigationCommit({});
		if (decision.disposition === "hard-navigate") {
			window.location.assign(window.location.href);
			return;
		}
		if (approvedCommit) {
			const latestApproval = approvePendingNavigationCommit({});
			if (latestApproval.decision.disposition === "hard-navigate") {
				window.location.assign(window.location.href);
				return;
			}
			if (latestApproval.approvedCommit) dispatchApprovedVisibleCommit(latestApproval.approvedCommit, null, false);
		}
		if (returnValue) {
			if (!returnValue.ok) throw returnValue.data;
			return returnValue.data;
		}
	}
}
`;

describe("payloadServerActionFix: navigation controller (vinext ≥0.0.47)", () => {
	const plugin = payloadServerActionFix();

	it("gates dispatchApprovedVisibleCommit on !returnValue inside commitSameUrlNavigatePayload", () => {
		const result = callTransform(plugin, CONTROLLER_FIXTURE, CONTROLLER_PATH);
		expect(result).toBeTruthy();
		const code = (result as { code: string }).code;
		expect(code).toContain(
			"if (latestApproval.approvedCommit && !returnValue) dispatchApprovedVisibleCommit",
		);
		// The unguarded form must be gone.
		expect(code).not.toMatch(
			/if \(latestApproval\.approvedCommit\) dispatchApprovedVisibleCommit/,
		);
	});

	it("is idempotent on already-patched code", () => {
		const first = callTransform(plugin, CONTROLLER_FIXTURE, CONTROLLER_PATH) as
			| { code: string }
			| undefined;
		if (!first) {
			throw new Error("expected transform to return patched code");
		}
		const second = callTransform(plugin, first.code, CONTROLLER_PATH);
		expect(second).toBeFalsy();
	});

	it("does not touch unrelated files", () => {
		const result = callTransform(
			plugin,
			"export const x = 1;",
			"/node_modules/some/other/module.js",
		);
		expect(result).toBeFalsy();
	});

	it("skips controller-named files that don't contain commitSameUrlNavigatePayload", () => {
		const result = callTransform(
			plugin,
			"// just a comment about app-browser-navigation-controller",
			CONTROLLER_PATH,
		);
		expect(result).toBeFalsy();
	});

	// Drift detector: run the transform against the actual installed vinext
	// controller. If vinext changes the function shape (e.g. renames or
	// inlines the dispatch call), this will fail loudly — which is exactly
	// when we need to update the AST pattern.
	it("transforms the actual installed vinext app-browser-navigation-controller.js", () => {
		const realPath = join(
			import.meta.dirname,
			"..",
			"node_modules/vinext/dist/server/app-browser-navigation-controller.js",
		);
		const real = readFileSync(realPath, "utf8");
		expect(real).toContain("commitSameUrlNavigatePayload");

		const result = callTransform(plugin, real, realPath);
		expect(result).toBeTruthy();
		const code = (result as { code: string }).code;
		// The gate can land in one of two shapes depending on vinext's emit:
		//  - 0.0.47–0.0.55 one-line form: `if ($COND && !returnValue) dispatchX(…)`
		//  - ≥0.1.0 block form: the bare dispatch wrapped as `if (!returnValue) dispatchX(…)`
		// vinext 0.0.50 renamed the dispatcher from dispatchApprovedVisibleCommit
		// to dispatchSynchronousVisibleCommit; either name is fine.
		expect(code).toMatch(
			/if \((latestApproval\.approvedCommit && )?!returnValue\) dispatch(Approved|Synchronous)VisibleCommit/,
		);
	});
});
