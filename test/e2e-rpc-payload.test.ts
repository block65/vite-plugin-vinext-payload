/**
 * E2E runtime test: vinextPayloadWorker with REAL payload + D1 adapter.
 *
 * `e2e-rpc-runtime` proves the workerd runtime shims with a React-only
 * worker; nothing there imports payload. That gap is how a consumer
 * report of a dep-optimization failure (payload 3.86, RPC worker,
 * `cloudflare:workers` + `drizzle-kit`) could neither be confirmed nor
 * refuted from the suite. This test closes it: a worker whose module
 * graph pulls in `payload`, `@payloadcms/db-d1-sqlite` (and through it
 * drizzle + `drizzle-kit/api` via createRequire), `richtext-lexical`,
 * a static `cloudflare:workers` import, and the cloudflare template's
 * `getPlatformProxy` wrangler fallback — with NO ssrExternal escape
 * hatch. If the optimizer or workerd chokes on any of that graph, the
 * fetch below never reaches the D1 query.
 *
 * The DB is deliberately unmigrated: reaching payload's first real
 * query ("Failed query: SELECT ... payload_migrations") proves payload
 * fully initialized through the adapter inside workerd, without
 * needing migration fixtures.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProjectHelpers,
	VERSIONS,
	waitForOutput,
	waitForServerReady,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-rpc-payload");
const WORKER_ENV = "ssr";
const helpers = createProjectHelpers(TEST_DIR);

const packageJson = JSON.stringify(
	{
		name: "rpc-payload-test",
		private: true,
		type: "module",
		scripts: { dev: "vite dev --port 0 --strictPort=false" },
	},
	null,
	2,
);

const wranglerJsonc = JSON.stringify(
	{
		name: "rpc-payload-worker",
		main: "src/index.ts",
		// 2025-11+: the cloudflare plugin's runner worker needs MessagePort,
		// absent from workerd under older compatibility dates.
		compatibility_date: "2025-11-01",
		compatibility_flags: ["nodejs_compat"],
		d1_databases: [
			{
				binding: "D1",
				database_name: "rpc-payload-test",
				database_id: "00000000-0000-0000-0000-000000000000",
			},
		],
	},
	null,
	2,
);

const viteConfig = `import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { vinextPayloadWorker } from "vite-plugin-vinext-payload";

// Deliberately NO ssrExternal: the plugin must handle this graph on its own.
export default defineConfig({
	plugins: [
		cloudflare({ viteEnvironment: { name: "${WORKER_ENV}" } }),
		...vinextPayloadWorker({ env: "${WORKER_ENV}" }),
	],
});
`;

// Mirrors payload's cloudflare templates: bindings via cloudflare:workers
// inside workerd, wrangler getPlatformProxy under plain Node. The wrangler
// branch must *resolve* in every Vite environment even though it only
// *executes* under Node — historically the path that dragged blake3-wasm
// into the graph.
const payloadConfig = `import { sqliteD1Adapter } from "@payloadcms/db-d1-sqlite";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import { buildConfig } from "payload";

async function getCloudflareEnv() {
	try {
		const { env } = await import(/* @vite-ignore */ "cloudflare:workers");
		return env;
	} catch {
		const { getPlatformProxy } = await import("wrangler");
		const proxy = await getPlatformProxy({});
		return proxy.env;
	}
}

const cfEnv = (await getCloudflareEnv()) as { D1: unknown };

export default buildConfig({
	secret: "rpc-payload-test-secret",
	editor: lexicalEditor(),
	db: sqliteD1Adapter({ binding: cfEnv.D1 as never }),
	collections: [
		{
			slug: "pages",
			fields: [{ name: "title", type: "text" }],
		},
	],
});
`;

const workerEntry = `import { WorkerEntrypoint } from "cloudflare:workers";
import { getPayload } from "payload";
import config from "./payload.config.js";

export class CmsEntrypoint extends WorkerEntrypoint {
	ping() {
		return "pong";
	}
}

export default {
	async fetch() {
		try {
			const payload = await getPayload({ config });
			const res = await payload.find({ collection: "pages" });
			return new Response("ok:" + JSON.stringify(res).slice(0, 100));
		} catch (e) {
			return new Response("payload-error:" + String(e), { status: 500 });
		}
	},
};
`;

async function scaffold() {
	await helpers.cleanup();
	await mkdir(TEST_DIR, { recursive: true });

	await helpers.write("package.json", packageJson);
	await helpers.write("wrangler.jsonc", wranglerJsonc);
	await helpers.write("vite.config.ts", viteConfig);
	await helpers.write("src/payload.config.ts", payloadConfig);
	await helpers.write("src/index.ts", workerEntry);

	await helpers.npm([
		"install",
		"-D",
		`vite@${VERSIONS.vite}`,
		"@cloudflare/vite-plugin@^1.37",
		"wrangler",
		`payload@${VERSIONS.payload}`,
		`@payloadcms/db-d1-sqlite@${VERSIONS.payload}`,
		`@payloadcms/richtext-lexical@${VERSIONS.payload}`,
		"graphql",
		"react@^19",
		"react-dom@^19",
		"--ignore-scripts",
	]);
	await helpers.npm(["install", "-D", PLUGIN_ROOT, "--ignore-scripts"]);
}

interface DevServer {
	port: number;
	proc: ChildProcess;
	output: () => string;
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

	let collected = "";
	proc.stdout?.on("data", (chunk: Buffer) => {
		collected += String(chunk);
	});
	proc.stderr?.on("data", (chunk: Buffer) => {
		collected += String(chunk);
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

	return {
		port: Number.parseInt(match[1], 10),
		proc,
		output: () => collected,
		kill,
	};
}

describe("e2e: payload + D1 adapter in RPC worker", () => {
	let server: DevServer;

	beforeAll(async () => {
		await scaffold();
		server = await startDev();
	}, 600_000);

	afterAll(async () => {
		await server?.kill();
		await helpers.cleanup();
	});

	it("payload initializes through the D1 adapter and reaches a real query", async () => {
		// The first request triggers on-demand optimization of the whole payload
		// graph; wait for the optimizer to report done rather than sleeping.
		await waitForServerReady(server.proc, server.port);

		const res = await fetch(`http://localhost:${server.port}/`);
		const body = await res.text();

		// "ok:" — the find() succeeded (won't happen on an unmigrated DB).
		// "payload-error:...Failed query" — payload fully initialized inside
		// workerd and the D1 adapter issued a real query against the empty
		// DB. Anything else (optimizer death, unresolved import, module-init
		// throw) fails here.
		expect(body).toMatch(/^ok:|^payload-error:.*Failed query/s);
	});

	it("dependency optimization completed without unresolved imports", () => {
		const log = server.output();
		expect(log).not.toMatch(/UNRESOLVED_IMPORT|Could not resolve/);
		expect(log).not.toMatch(/Error during dependency optimization/);
	});
});
