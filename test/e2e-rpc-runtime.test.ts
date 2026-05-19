/**
 * E2E runtime test: payloadWorkerPlugin under miniflare with React loaded.
 *
 * `vite build` resolves config but never runs the worker. Many of the
 * payload-plugin fixes (console.createTask polyfill, node:* → unenv,
 * import.meta.url guards) only fire at worker module-init time. This
 * test starts `vite dev`, waits for miniflare to bring the worker up,
 * and hits it via fetch — so any workerd runtime regression surfaces
 * as a test failure instead of a downstream consumer's stack trace.
 *
 * The worker entry imports React at module scope. React 19 dev mode
 * probes `console.createTask` during init; workerd's polyfill throws
 * "not implemented" unless our compat plugin patches it. That single
 * import is enough to flush out the regression class.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectHelpers, waitForOutput } from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-rpc-runtime");
const WORKER_ENV = "ssr";
const helpers = createProjectHelpers(TEST_DIR);

const packageJson = JSON.stringify(
	{
		name: "rpc-runtime-test",
		private: true,
		type: "module",
		scripts: { dev: "vite dev --port 0 --strictPort=false" },
	},
	null,
	2,
);

const wranglerJsonc = JSON.stringify(
	{
		name: "rpc-runtime-worker",
		main: "src/index.ts",
		compatibility_date: "2025-01-01",
		compatibility_flags: ["nodejs_compat"],
	},
	null,
	2,
);

const workerEntry = `import { WorkerEntrypoint } from "cloudflare:workers";
import * as React from "react";
import { renderToString } from "react-dom/server";

// Render in dev mode at request time. React 19's dev build probes
// \`console.createTask\` from its async-stack-trace setup; workerd's
// polyfill throws "not implemented" on call, so without our compat
// plugin's wrapper the render path throws and the response never
// becomes "ok:...".
function handle() {
	const html = renderToString(
		React.createElement("div", null, "hello-from-react"),
	);
	return new Response("ok:" + React.version + ":" + html.length, {
		status: 200,
	});
}

export class CmsEntrypoint extends WorkerEntrypoint {
	ping() {
		return "pong";
	}
}

export default { fetch: handle };
`;

const viteConfig = `import { cloudflare } from "@cloudflare/vite-plugin";
import { payloadWorkerPlugin } from "vite-plugin-vinext-payload";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		cloudflare({ viteEnvironment: { name: "${WORKER_ENV}" } }),
		...payloadWorkerPlugin({ env: "${WORKER_ENV}" }),
	],
});
`;

const tsconfig = JSON.stringify(
	{
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "bundler",
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			types: ["@cloudflare/workers-types"],
		},
		include: ["src", "vite.config.ts"],
	},
	null,
	2,
);

async function scaffold() {
	await helpers.cleanup();
	await mkdir(TEST_DIR, { recursive: true });

	await helpers.write("package.json", packageJson);
	await helpers.write("wrangler.jsonc", wranglerJsonc);
	await helpers.write("vite.config.ts", viteConfig);
	await helpers.write("tsconfig.json", tsconfig);
	await helpers.write("src/index.ts", workerEntry);

	await helpers.npm([
		"install",
		"-D",
		"vite@^8",
		"@cloudflare/vite-plugin@^1.37",
		"@cloudflare/workers-types",
		"react@^19",
		"react-dom@^19",
		"--legacy-peer-deps",
		"--ignore-scripts",
	]);
	await helpers.npm([
		"install",
		"-D",
		PLUGIN_ROOT,
		"--legacy-peer-deps",
		"--ignore-scripts",
	]);
}

interface DevServer {
	port: number;
	proc: ChildProcess;
	kill: () => Promise<void>;
}

async function startDev(): Promise<DevServer> {
	const proc = spawn("npm", ["run", "dev"], {
		cwd: TEST_DIR,
		stdio: "pipe",
		env: {
			...process.env,
			NODE_ENV: "development",
			NO_COLOR: "1",
			FORCE_COLOR: "0",
			CI: "1",
		},
	});

	const kill = async () => {
		proc.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				proc.kill("SIGKILL");
				resolve();
			}, 2000);
			proc.on("exit", () => {
				clearTimeout(t);
				resolve();
			});
		});
	};

	let match: RegExpMatchArray;
	try {
		match = await waitForOutput(
			proc,
			/Local:\s+https?:\/\/[^:\s]+:(\d+)\/?/,
			90_000,
		);
	} catch (err) {
		await kill();
		throw err;
	}

	return { port: Number.parseInt(match[1], 10), proc, kill };
}

describe("e2e: rpc worker runtime under miniflare", () => {
	let server: DevServer;

	beforeAll(async () => {
		await scaffold();
		server = await startDev();
	}, 300_000);

	afterAll(async () => {
		await server?.kill();
		await helpers.cleanup();
	});

	it("worker module-inits and serves a fetch without createTask error", async () => {
		// Retry briefly — miniflare's worker may still be warming after
		// vite reports "Local: ...".
		let res: Response | undefined;
		let body = "";
		for (let i = 0; i < 5; i++) {
			res = await fetch(`http://127.0.0.1:${server.port}/`);
			body = await res.text();
			if (res.status === 200 && body.startsWith("ok:")) {
				break;
			}
			await new Promise((r) => setTimeout(r, 1000));
		}

		expect(res?.status).toBe(200);
		expect(body).toMatch(/^ok:\d+\.\d+\.\d+:\d+$/); // ok:19.x.x:<html-length>
		expect(body).not.toMatch(/createTask/i);
		expect(body).not.toMatch(/not implemented/i);
	}, 120_000);
});
