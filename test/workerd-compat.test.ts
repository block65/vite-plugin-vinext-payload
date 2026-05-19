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
 * `serverEnvs` (which envs need workerd polyfills). `payloadPlugin`
 * defaults `reactEnv` to `"rsc"`; `payloadWorkerPlugin` sets it to the
 * worker's own env name. Passing `false` disables it entirely.
 */

import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { payloadWorkerPlugin } from "../src/main.ts";
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

const POLYFILL_PREFIX =
	"try{console.createTask('_')}catch(_e){console.createTask=function(){return{run:function(f){return f()}}}};";

describe("payloadWorkerdCompat: console.createTask polyfill", () => {
	it("prepends the polyfill on React files in the configured rscEnv (default)", () => {
		const plugin = payloadWorkerdCompat();
		const result = callTransform(plugin, "rsc", REACT_FIXTURE, REACT_FILE_ID);
		expect(result).not.toBeNull();
		expect(result).not.toBeUndefined();
		const out = typeof result === "object" && result !== null && "code" in result
			? (result as { code: string }).code
			: (result as string);
		expect(out.startsWith(POLYFILL_PREFIX)).toBe(true);
	});

	it("prepends the polyfill when reactEnv matches a custom server env", () => {
		// Mirrors payloadWorkerPlugin's call: reactEnv === worker env name.
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
		const out = typeof result === "object" && result !== null && "code" in result
			? (result as { code: string }).code
			: (result as string);
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
		// The transform may still return null/unchanged code, but it must
		// NOT have prepended the polyfill.
		if (result == null) {
			return;
		}
		const out = typeof result === "object" && "code" in result
			? (result as { code: string }).code
			: (result as string);
		expect(out.startsWith(POLYFILL_PREFIX)).toBe(false);
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
		expect(result == null).toBe(true);
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
		if (result == null) {
			return;
		}
		const out = typeof result === "object" && "code" in result
			? (result as { code: string }).code
			: (result as string);
		expect(out.startsWith(POLYFILL_PREFIX)).toBe(false);
	});
});

// Integration test for the headless plugin's composition. This guards
// the specific regression of `payloadWorkerPlugin` shipping with
// reactEnv:false — the symptom was workerd's `Console.createTask is
// not implemented` thrown at worker module init in a real consumer
// stack, which `vite build` and the synthetic runtime e2e couldn't
// reproduce. Validating the wiring directly makes the regression
// deterministic and fast to catch.
describe("payloadWorkerPlugin: composition wires createTask polyfill", () => {
	it("polyfills React in the worker's own env", () => {
		const env = "norfolk_cms";
		const plugins = payloadWorkerPlugin({ env });
		const compat = plugins.find(
			(p) => p.name === "vite-plugin-payload:workerd-compat",
		);
		expect(compat).toBeDefined();

		const result = callTransform(
			compat as Plugin,
			env,
			REACT_FIXTURE,
			REACT_FILE_ID,
		);
		expect(result).not.toBeNull();
		expect(result).not.toBeUndefined();
		const out = typeof result === "object" && result !== null && "code" in result
			? (result as { code: string }).code
			: (result as string);
		expect(out.startsWith(POLYFILL_PREFIX)).toBe(true);
	});
});
