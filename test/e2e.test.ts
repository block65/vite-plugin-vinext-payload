/**
 * End-to-end test: scaffold a Payload project, migrate to vinext,
 * run `vite-plugin-vinext-payload init`, start the dev server,
 * and verify routes respond.
 *
 * Requires network access (degit downloads template from GitHub).
 * Timeout is generous because npm install is slow.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project");

// Known-good version matrix
const VERSIONS = {
	payload: "3.77.0",
	vinext: "0.0.31",
	vite: "7",
	pluginReact: "5",
	pluginRsc: "0.5",
} as const;

// ── Helpers ────────────────────────────────────────────────────────

function exec(cmd: string, args: string[], cwd: string) {
	return execFileSync(cmd, args, {
		cwd,
		stdio: "pipe",
		encoding: "utf8",
		timeout: 300_000,
		env: process.env,
	});
}

const npm = (args: string[]) => exec("npm", args, TEST_DIR);
const npx = (args: string[]) => exec("npx", args, TEST_DIR);

function readProject(path: string) {
	return readFileSync(join(TEST_DIR, path), "utf8");
}

function writeProject(path: string, content: string) {
	writeFileSync(join(TEST_DIR, path), content);
}

function readProjectJson(path: string) {
	return JSON.parse(readProject(path));
}

function writeProjectJson(path: string, data: unknown) {
	writeProject(path, JSON.stringify(data, null, 2) + "\n");
}

function randomHex(bytes: number) {
	return Array.from({ length: bytes }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/** Yield lines from a spawned process until a pattern matches or timeout. */
async function* processLines(proc: ChildProcess, signal?: AbortSignal) {
	let buffer = "";
	const lines: string[] = [];
	const pending: ((line: string) => void)[] = [];

	function push(chunk: string) {
		buffer += chunk;
		const parts = buffer.split("\n");
		buffer = parts.pop() ?? "";
		for (const line of parts) {
			const waiter = pending.shift();
			if (waiter) {
				waiter(line);
			} else {
				lines.push(line);
			}
		}
	}

	proc.stdout?.on("data", (d: Buffer) => push(d.toString()));
	proc.stderr?.on("data", (d: Buffer) => push(d.toString()));

	while (!signal?.aborted) {
		const next = lines.shift();
		if (next !== undefined) {
			yield next;
			continue;
		}
		const line = await new Promise<string>((resolve, reject) => {
			pending.push(resolve);
			signal?.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		});
		yield line;
	}
}

/** Start a dev server, wait for it to print a port, return the port. */
async function startDevServer(cwd: string): Promise<{ port: number; proc: ChildProcess }> {
	const pkg = readProjectJson("package.json");
	const script = pkg.scripts["dev:vinext"] ? "dev:vinext" : "dev";

	const proc = spawn("npm", ["run", script], {
		cwd,
		stdio: "pipe",
		env: { ...process.env, NODE_ENV: "development" },
	});

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("dev server did not start")), 30_000);

	try {
		for await (const line of processLines(proc, controller.signal)) {
			const match = line.match(/localhost:(\d+)/);
			if (match) {
				return { port: parseInt(match[1], 10), proc };
			}
		}
	} finally {
		clearTimeout(timeout);
	}

	throw new Error("dev server exited without printing a port");
}

async function assertStatus(port: number, path: string, expected: number[]) {
	const res = await fetch(`http://localhost:${port}${path}`, { redirect: "manual" });
	assert.ok(
		expected.includes(res.status),
		`GET ${path} expected ${expected.join("|")}, got ${res.status}`,
	);
}

// ── Scaffold ───────────────────────────────────────────────────────

function scaffoldProject() {
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true, force: true });
	}

	// Clone template
	exec("npx", ["--yes", "degit", "payloadcms/payload/templates/with-postgres", TEST_DIR], PLUGIN_ROOT);

	// Swap postgres → sqlite (no external DB needed)
	const pkg = readProjectJson("package.json");
	delete pkg.dependencies["@payloadcms/db-postgres"];
	pkg.dependencies["@payloadcms/db-sqlite"] = VERSIONS.payload;
	writeProjectJson("package.json", pkg);

	const config = readProject("src/payload.config.ts")
		.replace(
			"import { postgresAdapter } from '@payloadcms/db-postgres'",
			"import { sqliteAdapter } from '@payloadcms/db-sqlite'",
		)
		.replace(
			/db: postgresAdapter\(\{[\s\S]*?\}\),/,
			"db: sqliteAdapter({ client: { url: 'file:./data/payload.db' } }),",
		);
	writeProject("src/payload.config.ts", config);
	mkdirSync(join(TEST_DIR, "data"), { recursive: true });

	// Create .env
	writeProject(".env", `PAYLOAD_SECRET=${randomHex(32)}\n`);

	// Install deps
	npm(["install", "--ignore-scripts"]);
	npm(["rebuild", "esbuild"]);

	// Install vinext + vite (pinned)
	npm([
		"install",
		"-D",
		`vinext@${VERSIONS.vinext}`,
		`vite@${VERSIONS.vite}`,
		`@vitejs/plugin-rsc@${VERSIONS.pluginRsc}`,
		`@vitejs/plugin-react@${VERSIONS.pluginReact}`,
		"--legacy-peer-deps",
	]);

	// Run vinext init
	npx(["vinext", "init"]);

	// Install our plugin from local source
	npm(["install", "-D", PLUGIN_ROOT, "--legacy-peer-deps"]);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("e2e: payload + vinext migration", { timeout: 600_000 }, () => {
	let server: { port: number; proc: ChildProcess } | null = null;

	before(() => {
		scaffoldProject();

		// Run our init
		const output = npx(["vite-plugin-vinext-payload", "init"]);
		console.log(output);

		// Generate import map
		npx(["payload", "generate:importmap"]);
	});

	after(async () => {
		server?.proc.kill("SIGTERM");
		await sleep(1000);
		server?.proc.kill("SIGKILL");
		server = null;

		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	it("creates serverFunction.ts", () => {
		assert.ok(existsSync(join(TEST_DIR, "src/app/(payload)/serverFunction.ts")));
	});

	it("adds payloadPlugin to vite.config.ts", () => {
		const config = readProject("vite.config.ts");
		assert.ok(config.includes("payloadPlugin"));
		assert.ok(config.includes("vite-plugin-vinext-payload"));
	});

	it("adds normalizeParams to page.tsx", () => {
		const page = readProject("src/app/(payload)/admin/[[...segments]]/page.tsx");
		assert.ok(page.includes("normalizeParams"));
	});

	it("is idempotent", () => {
		const output = npx(["vite-plugin-vinext-payload", "init"]);
		assert.ok(output.includes("0 file(s) changed"));
	});

	it("dev server responds on / and /admin", async () => {
		server = await startDevServer(TEST_DIR);

		// First request triggers compilation — give it time
		await sleep(5000);

		await assertStatus(server.port, "/", [200]);
		await assertStatus(server.port, "/admin", [200, 302, 307]);
	});
});
