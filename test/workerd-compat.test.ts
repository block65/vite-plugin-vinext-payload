/**
 * Unit tests for `payloadWorkerdCompat`.
 *
 * Regression coverage for the `console.createTask` polyfill: workerd's
 * `node:console` defines `createTask` but throws "not implemented" when
 * called. React 19 dev mode probes for the function and invokes it for
 * async stack traces — so worker module init crashes unless our plugin
 * prepends a try/catch wrapper to React files.
 *
 * The plugin is parameterized by `reactEnv` (which env loads React) and
 * `serverEnvs` (which envs need workerd polyfills). `vinextPayload`
 * defaults `reactEnv` to `"rsc"`; `vinextPayloadWorker` sets it to the
 * worker's own env name. Passing `false` disables it entirely.
 */

import type { Plugin } from "vite";
import { assert, describe, expect, it } from "vitest";
import { vinextPayloadWorker } from "../src/main.ts";
import { payloadWorkerdCompat } from "../src/workerd-compat.ts";

const REACT_FILE_ID = "/node_modules/react/cjs/react.development.js";
const REACT_FIXTURE = `
'use strict';
exports.createElement = function createElement() {};
// React 19 dev probes \`console.createTask\` for owner stacks.
var enableOwnerStacks = typeof console.createTask === 'function';
`;

function callTransform(plugin: Plugin, env: string, code: string, id: string) {
	const hook = plugin.transform;
	if (typeof hook !== "function" && typeof hook?.handler !== "function") {
		throw new Error("expected plugin.transform to expose a handler");
	}
	const handler = typeof hook === "function" ? hook : hook.handler;
	const ctx = { environment: { name: env } };
	return handler.call(ctx as never, code, id);
}

/** Narrows a Vite transform result to its emitted code without casting. */
function hasCode(value: unknown): value is { code: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		typeof value.code === "string"
	);
}

function transformedCode(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}
	if (hasCode(result)) {
		return result.code;
	}
	throw new Error(
		`expected the transform to emit code, got ${JSON.stringify(result)}`,
	);
}

const POLYFILL_PREFIX =
	"try{console.createTask('_')}catch(_e){console.createTask=function(){return{run:function(f){return f()}}}};";

describe("payloadWorkerdCompat: console.createTask polyfill", () => {
	it("prepends the polyfill on React files in the configured rscEnv (default)", () => {
		const plugin = payloadWorkerdCompat();
		const result = callTransform(plugin, "rsc", REACT_FIXTURE, REACT_FILE_ID);
		expect(result).not.toBeNull();
		expect(result).not.toBeUndefined();
		const out = transformedCode(result);
		expect(out.startsWith(POLYFILL_PREFIX)).toBe(true);
	});

	it("prepends the polyfill when reactEnv matches a custom server env", () => {
		// Mirrors vinextPayloadWorker's call: reactEnv === worker env name.
		const plugin = payloadWorkerdCompat({
			serverEnvs: ["norfolk_cms"],
			reactEnv: "norfolk_cms",
		});
		const result = callTransform(
			plugin,
			"norfolk_cms",
			REACT_FIXTURE,
			REACT_FILE_ID,
		);
		const out = transformedCode(result);
		expect(out.startsWith(POLYFILL_PREFIX)).toBe(true);
	});

	it("skips the polyfill when reactEnv is false (regression guard)", () => {
		// This is the bug that hit a real payload-cms auxiliary worker:
		// reactEnv:false meant payload.config.ts's admin-component imports
		// pulled React in but the polyfill never landed, so module init
		// hit workerd's broken createTask and threw "not implemented".
		const plugin = payloadWorkerdCompat({
			serverEnvs: ["norfolk_cms"],
			reactEnv: false,
		});
		const result = callTransform(
			plugin,
			"norfolk_cms",
			REACT_FIXTURE,
			REACT_FILE_ID,
		);
		// reactEnv:false must skip entirely. The transform signals "no change"
		// with null, so that is the assertion — an early return here would let
		// the test pass without checking anything.
		expect(result).toBeNull();
	});

	it("skips the polyfill in non-server envs even when code matches", () => {
		const plugin = payloadWorkerdCompat();
		const result = callTransform(
			plugin,
			"client",
			REACT_FIXTURE,
			REACT_FILE_ID,
		);
		// transform's outer guard returns null for non-server envs.
		expect(result).toBeNull();
	});

	it("skips the polyfill for non-React files even in the rscEnv", () => {
		const plugin = payloadWorkerdCompat();
		const result = callTransform(
			plugin,
			"rsc",
			REACT_FIXTURE,
			"/node_modules/some-other-pkg/index.js",
		);
		// React-id gating is the only thing keeping the polyfill from
		// being injected into unrelated packages.
		expect(result).toBeNull();
	});
});

// Integration test for the headless plugin's composition. This guards
// the specific regression of `vinextPayloadWorker` shipping with
// reactEnv:false — the symptom was workerd's `Console.createTask is
// not implemented` thrown at worker module init in a real consumer
// stack, which `vite build` and the synthetic runtime e2e couldn't
// reproduce. Validating the wiring directly makes the regression
// deterministic and fast to catch.
describe("vinextPayloadWorker: composition wires createTask polyfill", () => {
	it("polyfills React in the worker's own env", () => {
		const env = "norfolk_cms";
		const plugins = vinextPayloadWorker({ env });
		const compat = plugins.find(
			(p) => p.name === "vite-plugin-payload:workerd-compat",
		);
		assert(compat, "expected the workerd-compat plugin to be composed in");

		const result = callTransform(compat, env, REACT_FIXTURE, REACT_FILE_ID);
		expect(result).not.toBeNull();
		expect(result).not.toBeUndefined();
		const out = transformedCode(result);
		expect(out.startsWith(POLYFILL_PREFIX)).toBe(true);
	});
});
