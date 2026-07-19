/**
 * Regression guard: `vinextPayloadWorker` must scope its CJS-related
 * sub-plugins to the worker env only. The previous version applied
 * `payloadCjsTransform`, `payloadCliStubs`, and `cjsInterop` globally,
 * which meant a website using `vinextPayloadWorker({ env: "cms" })`
 * for an auxiliary worker also had its `client` build mangled by the
 * Payload-targeted CJS wrapping — clobbering named exports of
 * unrelated CJS deps (e.g. `use-sync-external-store/shim/with-selector`,
 * `maplibre-gl`) at production build time.
 *
 * Dev hides this because client deps go through esbuild's optimizeDeps
 * pre-bundle, which emits real ESM before our transform ever sees them.
 * Only the prod client build, which serves raw node_modules, hit the bug.
 */

import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { payloadCjsTransform } from "../src/cjs-transform.ts";
import { payloadCliStubs } from "../src/cli-stubs.ts";
import { vinextPayload, vinextPayloadWorker } from "../src/main.ts";

const WORKER_ENV = "norfolk_cms";

function callApplyToEnvironment(plugin: Plugin, envName: string) {
	const fn = plugin.applyToEnvironment;
	if (typeof fn !== "function") {
		return null;
	}
	return fn.call(undefined as never, { name: envName } as never);
}

describe("payloadCjsTransform: envs scoping", () => {
	it("has no applyToEnvironment when envs is undefined (default)", () => {
		const plugin = payloadCjsTransform();
		expect(plugin.applyToEnvironment).toBeUndefined();
	});

	it("applies only to listed envs when envs is set", () => {
		const plugin = payloadCjsTransform({ envs: [WORKER_ENV] });
		expect(callApplyToEnvironment(plugin, WORKER_ENV)).toBe(true);
		expect(callApplyToEnvironment(plugin, "client")).toBe(false);
		expect(callApplyToEnvironment(plugin, "ssr")).toBe(false);
		expect(callApplyToEnvironment(plugin, "rsc")).toBe(false);
	});
});

describe("payloadCliStubs: envs scoping", () => {
	it("has no applyToEnvironment when envs is undefined (default)", () => {
		const plugin = payloadCliStubs();
		expect(plugin.applyToEnvironment).toBeUndefined();
	});

	it("applies only to listed envs when envs is set", () => {
		const plugin = payloadCliStubs({ envs: [WORKER_ENV] });
		expect(callApplyToEnvironment(plugin, WORKER_ENV)).toBe(true);
		expect(callApplyToEnvironment(plugin, "client")).toBe(false);
	});
});

describe("vinextPayloadWorker: client env is never touched", () => {
	const plugins = vinextPayloadWorker({ env: WORKER_ENV });

	const targets = [
		"vite-plugin-payload:cjs-transform",
		"vite-plugin-payload:cli-stubs",
		"cjs-interop",
	];

	for (const name of targets) {
		it(`${name} rejects the client env via applyToEnvironment`, () => {
			const plugin = plugins.find((p) => p.name === name);
			expect(plugin, `expected sub-plugin ${name}`).toBeDefined();
			expect(callApplyToEnvironment(plugin as Plugin, "client")).toBe(false);
		});

		it(`${name} accepts the worker env via applyToEnvironment`, () => {
			const plugin = plugins.find((p) => p.name === name);
			expect(plugin, `expected sub-plugin ${name}`).toBeDefined();
			expect(callApplyToEnvironment(plugin as Plugin, WORKER_ENV)).toBe(true);
		});
	}
});

describe("vinextPayload: keeps unscoped sub-plugins (Payload admin UI needs client)", () => {
	const plugins = vinextPayload();

	it("cjs-transform stays unscoped so the admin UI client build still benefits", () => {
		const plugin = plugins.find(
			(p) => p.name === "vite-plugin-payload:cjs-transform",
		);
		expect(plugin).toBeDefined();
		expect((plugin as Plugin).applyToEnvironment).toBeUndefined();
	});

	it("cli-stubs stays unscoped so admin-UI client doesn't try to bundle ws etc.", () => {
		const plugin = plugins.find(
			(p) => p.name === "vite-plugin-payload:cli-stubs",
		);
		expect(plugin).toBeDefined();
		expect((plugin as Plugin).applyToEnvironment).toBeUndefined();
	});
});
