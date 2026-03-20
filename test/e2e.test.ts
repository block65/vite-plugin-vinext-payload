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
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_ROOT = join(__dirname, "..");
const TEST_DIR = join(__dirname, ".test-project");
const TIMEOUT = 600_000; // 10 minutes for full e2e (npm install is slow)

// Known-good version matrix
const VERSIONS = {
	payload: "3.77.0",
	vinext: "0.0.31",
	vite: "7",
	pluginReact: "5",
	pluginRsc: "0.5",
};

function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>) {
	return execFileSync(cmd, args, {
		cwd,
		stdio: "pipe",
		encoding: "utf8",
		timeout: 300_000,
		env: { ...process.env, ...env },
	});
}

function runNpm(args: string[], cwd: string) {
	return run("npm", args, cwd);
}

describe("e2e: payload + vinext migration", { timeout: TIMEOUT }, () => {
	let devServer: ChildProcess | null = null;
	let devPort: number | null = null;

	before(async () => {
		// Clean up previous test
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}

		// 1. Clone the Payload with-postgres template (has real version numbers)
		run("npx", ["--yes", "degit", "payloadcms/payload/templates/with-postgres", TEST_DIR], PLUGIN_ROOT);
		assert.ok(existsSync(join(TEST_DIR, "package.json")), "Template cloned");

		// 2. Swap postgres for sqlite (no external DB needed)
		const pkg = JSON.parse(readFileSync(join(TEST_DIR, "package.json"), "utf8"));
		delete pkg.dependencies["@payloadcms/db-postgres"];
		pkg.dependencies["@payloadcms/db-sqlite"] = VERSIONS.payload;
		writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

		const configPath = join(TEST_DIR, "src/payload.config.ts");
		let config = readFileSync(configPath, "utf8");
		config = config.replace(
			"import { postgresAdapter } from '@payloadcms/db-postgres'",
			"import { sqliteAdapter } from '@payloadcms/db-sqlite'",
		);
		config = config.replace(
			/db: postgresAdapter\(\{[\s\S]*?\}\),/,
			"db: sqliteAdapter({ client: { url: 'file:./data/payload.db' } }),",
		);
		writeFileSync(configPath, config);
		mkdirSync(join(TEST_DIR, "data"), { recursive: true });

		// 3. Create .env
		writeFileSync(
			join(TEST_DIR, ".env"),
			`PAYLOAD_SECRET=${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}\n`,
		);

		// 4. Install deps
		runNpm(["install", "--ignore-scripts"], TEST_DIR);
		runNpm(["rebuild", "esbuild"], TEST_DIR);

		// 5. Install vinext + vite (pinned versions)
		runNpm(
			[
				"install",
				"-D",
				`vinext@${VERSIONS.vinext}`,
				`vite@${VERSIONS.vite}`,
				`@vitejs/plugin-rsc@${VERSIONS.pluginRsc}`,
				`@vitejs/plugin-react@${VERSIONS.pluginReact}`,
				"--legacy-peer-deps",
			],
			TEST_DIR,
		);

		// 6. Run vinext init
		run("npx", ["vinext", "init"], TEST_DIR);
		assert.ok(existsSync(join(TEST_DIR, "vite.config.ts")), "vinext init created vite.config.ts");

		// 7. Install our plugin (from local)
		runNpm(["install", "-D", PLUGIN_ROOT, "--legacy-peer-deps"], TEST_DIR);

		// 8. Run our init
		const initOutput = run("npx", ["vite-plugin-vinext-payload", "init"], TEST_DIR);
		console.log("init output:", initOutput);

		// 9. Generate import map
		run("npx", ["payload", "generate:importmap"], TEST_DIR);
	});

	after(async () => {
		if (devServer) {
			devServer.kill("SIGTERM");
			await sleep(1000);
			devServer.kill("SIGKILL");
			devServer = null;
		}
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	it("init creates serverFunction.ts", () => {
		assert.ok(
			existsSync(join(TEST_DIR, "src/app/(payload)/serverFunction.ts")),
			"serverFunction.ts should exist",
		);
	});

	it("init adds payloadPlugin to vite.config.ts", () => {
		const config = readFileSync(join(TEST_DIR, "vite.config.ts"), "utf8");
		assert.ok(config.includes("payloadPlugin"), "vite.config.ts should contain payloadPlugin");
		assert.ok(
			config.includes("vite-plugin-vinext-payload"),
			"vite.config.ts should import from vite-plugin-vinext-payload",
		);
	});

	it("init adds normalizeParams to page.tsx", () => {
		const page = readFileSync(
			join(TEST_DIR, "src/app/(payload)/admin/[[...segments]]/page.tsx"),
			"utf8",
		);
		assert.ok(page.includes("normalizeParams"), "page.tsx should contain normalizeParams");
	});

	it("init is idempotent", () => {
		const output = run("npx", ["vite-plugin-vinext-payload", "init"], TEST_DIR);
		assert.ok(output.includes("0 file(s) changed"), "Second run should change 0 files");
	});

	it("dev server starts and responds", async () => {
		// Find the dev script vinext created
		const pkg = JSON.parse(readFileSync(join(TEST_DIR, "package.json"), "utf8"));
		const devScript = pkg.scripts["dev:vinext"] ? "dev:vinext" : "dev";

		devServer = spawn("npm", ["run", devScript], {
			cwd: TEST_DIR,
			stdio: "pipe",
			env: { ...process.env, NODE_ENV: "development" },
		});

		// Capture output to find the port
		let output = "";
		devServer.stdout?.on("data", (d: Buffer) => {
			output += d.toString();
		});
		devServer.stderr?.on("data", (d: Buffer) => {
			output += d.toString();
		});

		// Wait for server to be ready (look for the URL in output)
		const startTime = Date.now();
		while (Date.now() - startTime < 30_000) {
			const match = output.match(/localhost:(\d+)/);
			if (match) {
				devPort = parseInt(match[1], 10);
				break;
			}
			await sleep(500);
		}

		assert.ok(devPort, `Dev server should print a port. Output: ${output.slice(0, 500)}`);

		// Wait for first request to compile
		await sleep(5000);

		// Test homepage
		const homeRes = await fetch(`http://localhost:${devPort}/`);
		assert.equal(homeRes.status, 200, "GET / should return 200");

		// Test admin redirect
		const adminRes = await fetch(`http://localhost:${devPort}/admin`, { redirect: "manual" });
		assert.ok(
			[200, 307, 302].includes(adminRes.status),
			`GET /admin should return 200 or redirect, got ${adminRes.status}`,
		);
	});
});
