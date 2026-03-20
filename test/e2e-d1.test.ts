/**
 * E2E test: Cloudflare D1 migration.
 * Scaffolds a Payload project from the with-cloudflare-d1 template,
 * migrates to vinext, rewrites payload.config.ts for vinext compatibility,
 * runs init, starts the dev server, asserts routes.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createProjectHelpers,
  installVinextStack,
  rewritePayloadConfigForVinext,
  fixWranglerForLocalDev,
  waitForOutput,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-d1");
const helpers = createProjectHelpers(TEST_DIR);

async function assertStatus(port: number, path: string, expected: number[]) {
  const res = await fetch(`http://localhost:${port}${path}`, { redirect: "manual" });
  assert.ok(
    expected.includes(res.status),
    `GET ${path} expected ${expected.join("|")}, got ${res.status}`,
  );
}

async function scaffoldD1Project() {
  await helpers.cleanup();
  await mkdir(TEST_DIR, { recursive: true });
  await helpers.npx([
    "--yes",
    "degit",
    "payloadcms/payload/templates/with-cloudflare-d1",
    TEST_DIR,
  ]);

  await writeFile(join(TEST_DIR, ".env"), `PAYLOAD_SECRET=${crypto.randomUUID()}\n`);

  await installVinextStack(helpers, PLUGIN_ROOT);

  // D1-specific: rewrite payload.config.ts and fix wrangler
  await rewritePayloadConfigForVinext(helpers);
  await fixWranglerForLocalDev(helpers);
}

describe("e2e: cloudflare d1 migration", { timeout: 600_000 }, () => {
  let server: ChildProcess | null = null;

  before(async () => {
    await scaffoldD1Project();

    const output = await helpers.npx(["vite-plugin-vinext-payload", "init"]);
    console.log(output);

    await helpers.npx(["payload", "generate:importmap"]);
  });

  after(async () => {
    server?.kill("SIGTERM");
    await sleep(1000);
    server?.kill("SIGKILL");
    server = null;
    await helpers.cleanup();
  });

  it("creates serverFunction.ts", async () => {
    assert.ok(await helpers.exists("src/app/(payload)/serverFunction.ts"));
  });

  it("adds payloadPlugin to vite.config.ts", async () => {
    const config = await helpers.read("vite.config.ts");
    assert.ok(config.includes("payloadPlugin"));
    assert.ok(config.includes("vite-plugin-vinext-payload"));
  });

  it("payload.config.ts uses getCloudflareEnv", async () => {
    const config = await helpers.read("src/payload.config.ts");
    assert.ok(config.includes("getCloudflareEnv"), "should have getCloudflareEnv function");
    assert.ok(
      !config.includes("@opennextjs/cloudflare"),
      "should not import from @opennextjs/cloudflare",
    );
    assert.ok(
      !config.includes("getCloudflareContext"),
      "should not reference getCloudflareContext",
    );
  });

  it("wrangler.jsonc has no remote: true", async () => {
    const wrangler = await helpers.read("wrangler.jsonc");
    assert.ok(!/"remote"\s*:\s*true/.test(wrangler), "should not have remote: true");
  });

  it("is idempotent", async () => {
    const output = await helpers.npx(["vite-plugin-vinext-payload", "init"]);
    assert.ok(output.includes("0 file(s) changed"));
  });

  it("dev server responds on / and /admin", async () => {
    const pkg = JSON.parse(await helpers.read("package.json"));
    const script = pkg.scripts["dev:vinext"] ? "dev:vinext" : "dev";

    server = spawn("npm", ["run", script], {
      cwd: TEST_DIR,
      stdio: "pipe",
      env: { ...process.env, NODE_ENV: "development" },
    });

    const match = await waitForOutput(server, /localhost:(\d+)/);
    const port = Number.parseInt(match[1], 10);

    await sleep(5000);

    await assertStatus(port, "/", [200]);
    await assertStatus(port, "/admin", [200, 302, 307]);
  });
});
