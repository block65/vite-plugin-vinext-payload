import { execFile as execFileCb, spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/** Known-good version pins for testing. */
export const VERSIONS = {
  payload: "3.84.1",
  vinext: "0.0.45",
} as const;

const execFile = promisify(execFileCb);

export function createProjectHelpers(testDir: string) {
  async function run(cmd: string, args: string[], cwd = testDir) {
    const { stdout } = await execFile(cmd, args, {
      cwd,
      timeout: 300_000,
      env: process.env,
    });
    return stdout;
  }

  return {
    run,
    npm: (args: string[]) => run("npm", args),
    npx: (args: string[]) => run("npx", args),
    read: (path: string) => readFile(join(testDir, path), "utf8"),
    write: async (path: string, content: string) => {
      await mkdir(dirname(join(testDir, path)), { recursive: true });
      await writeFile(join(testDir, path), content);
    },
    exists: (path: string) =>
      access(join(testDir, path))
        .then(() => true)
        .catch(() => false),
    cleanup: () => rm(testDir, { recursive: true, force: true }).catch(() => {}),
  };
}

/** Run a production build (vite build) and return stdout. */
export async function runBuild(helpers: ReturnType<typeof createProjectHelpers>) {
  const pkg = JSON.parse(await helpers.read("package.json"));
  const script = pkg.scripts["build:vinext"] ? "build:vinext" : "build";
  return helpers.npm(["run", script]);
}

/** Start a dev server, wait for it to print a port, return port + kill function. */
export async function startDevServer(
  testDir: string,
  helpers: ReturnType<typeof createProjectHelpers>,
) {
  const pkg = JSON.parse(await helpers.read("package.json"));
  const script = pkg.scripts["dev:vinext"] ? "dev:vinext" : "dev";

  const proc = spawn("npm", ["run", script], {
    cwd: testDir,
    stdio: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "development",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      CI: process.env.CI || "1",
    },
  });

  let match: RegExpMatchArray;
  try {
    match = await waitForOutput(
      proc,
      /Local:\s+https?:\/\/[^:\s]+:(\d+)\/?/,
    );
  } catch (error) {
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    throw error;
  }

  const port = Number.parseInt(match[1], 10);

  const kill = async () => {
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  };

  return { port, kill, [Symbol.asyncDispose]: kill };
}

/** Wait for a spawned process stdout to match a pattern. */
export function waitForOutput(proc: ChildProcess, pattern: RegExp, timeoutMs = 60_000) {
  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");

  return new Promise<RegExpMatchArray>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}. Output:\n${output.slice(-500)}`));
    }, timeoutMs);

    const onData = (chunk: string) => {
      output += chunk;
      const match = output.match(pattern);
      if (match) {
        cleanup();
        resolve(match);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onData);
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
  });
}

/**
 * Fetch a route from the dev server and assert the status code.
 * Retries with 2s delay for cold-start compilation.
 */
export async function assertStatus(port: number, path: string, expected: number[], retries = 3) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`http://localhost:${port}${path}`, { redirect: "manual" });
    lastStatus = res.status;
    if (expected.includes(lastStatus)) {
      return res;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`GET ${path} expected ${expected.join("|")}, got ${lastStatus}`);
}

// ── Fixtures ───────────────────────────────────────────────────────

export const FIXTURES = {
  packageJson: JSON.stringify(
    {
      name: "test-project",
      dependencies: { payload: `^${VERSIONS.payload}` },
      devDependencies: { vinext: `^${VERSIONS.vinext}` },
    },
    null,
    2,
  ),

  viteConfigSingleLine: `import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vinext()],
});
`,

  viteConfigMultiLine: `import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext(),
  ],
});
`,

  viteConfigTabs: `import { defineConfig } from 'vite';
import vinext from 'vinext';

export default defineConfig({
\tplugins: [
\t\tvinext(),
\t],
});
`,

  originalLayout: `/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
/* DO NOT MODIFY IT BECAUSE IT COULD BE REWRITTEN AT ANY TIME. */
import config from '@payload-config'
import '@payloadcms/next/css'
import type { ServerFunctionClient } from 'payload'
import { handleServerFunctions, RootLayout } from '@payloadcms/next/layouts'
import React from 'react'

import { importMap } from './admin/importMap.js'
import './custom.scss'

type Args = {
  children: React.ReactNode
}

const serverFunction: ServerFunctionClient = async function (args) {
  'use server'
  return handleServerFunctions({
    ...args,
    config,
    importMap,
  })
}

const Layout = ({ children }: Args) => (
  <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
    {children}
  </RootLayout>
)

export default Layout
`,

  originalPage: `/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
/* DO NOT MODIFY IT BECAUSE IT COULD BE REWRITTEN AT ANY TIME. */
import type { Metadata } from 'next'

import config from '@payload-config'
import { RootPage, generatePageMetadata } from '@payloadcms/next/views'
import { importMap } from '../importMap'

type Args = {
  params: Promise<{
    segments: string[]
  }>
  searchParams: Promise<{
    [key: string]: string | string[]
  }>
}

export const generateMetadata = ({ params, searchParams }: Args): Promise<Metadata> =>
  generatePageMetadata({ config, params, searchParams })

const Page = ({ params, searchParams }: Args) =>
  RootPage({ config, params, searchParams, importMap })

export default Page
`,

  tsconfig: JSON.stringify(
    {
      compilerOptions: {
        paths: { "@payload-config": ["./src/payload.config.ts"] },
      },
    },
    null,
    2,
  ),
} as const;

/** Scaffold a minimal mock Payload project for unit tests. */
export async function scaffoldMockProject(
  testDir: string,
  viteConfig: string = FIXTURES.viteConfigSingleLine,
  options?: { wranglerConfig?: boolean },
) {
  const { write, cleanup } = createProjectHelpers(testDir);
  await cleanup();
  await write("package.json", FIXTURES.packageJson);
  await write("vite.config.ts", viteConfig);
  await write("tsconfig.json", FIXTURES.tsconfig);
  await write("src/app/(payload)/layout.tsx", FIXTURES.originalLayout);
  await write("src/app/(payload)/admin/[[...segments]]/page.tsx", FIXTURES.originalPage);
  if (options?.wranglerConfig) {
    await write("wrangler.jsonc", '{ "name": "test" }');
  }
}

/**
 * Install deps, run vinext init, install the plugin.
 *
 * --ignore-scripts: sharp has no prebuilt binary for Node 24 and
 *   falls back to a source build requiring node-addon-api.
 * --legacy-peer-deps: the Payload template pins @vitejs/plugin-react@4
 *   which conflicts with vinext's peer dep on @vitejs/plugin-react@5+.
 *   vinext init also runs npm install internally without --legacy-peer-deps
 *   which can fail — we pre-install vinext+vite first to avoid this.
 */
export async function installVinextStack(
  helpers: ReturnType<typeof createProjectHelpers>,
  pluginRoot: string,
) {
  await helpers.npm(["install", "--ignore-scripts"]);
  await helpers.npm(["rebuild", "esbuild"]);
  await helpers.npm(["install", "-D", "vinext", "vite", "--legacy-peer-deps"]);
  await helpers.npx(["vinext", "init"]);
  const pkg = JSON.parse(await helpers.read("package.json"));
  if (pkg.devDependencies?.["@cloudflare/vite-plugin"]) {
    await helpers.npm(["install", "-D", "@cloudflare/vite-plugin", "--legacy-peer-deps"]);
  }
  await helpers.npm(["install", "-D", pluginRoot, "--legacy-peer-deps"]);
}

/**
 * Rewrite payload.config.ts to replace OpenNext cloudflare context
 * with getCloudflareEnv. Uses ast-grep for structural matching.
 */
export async function rewritePayloadConfigForVinext(
  helpers: ReturnType<typeof createProjectHelpers>,
) {
  const { parse, Lang } = await import("@ast-grep/napi");
  const configPath = "src/payload.config.ts";
  const code = await helpers.read(configPath);
  const root = parse(Lang.TypeScript, code).root();

  const edits: { start: number; end: number; replacement: string }[] = [];

  const removeNode = (node: ReturnType<typeof root.find>, includeTrailingNewline = true) => {
    if (!node) {
      return;
    }
    const r = node.range();
    const end = includeTrailingNewline
      ? code.indexOf("\n", r.end.index) + 1 || r.end.index
      : r.end.index;
    edits.push({ start: r.start.index, end, replacement: "" });
  };

  // 1. Remove @opennextjs/cloudflare import
  removeNode(
    root.find({
      rule: {
        kind: "import_statement",
        has: { pattern: "'@opennextjs/cloudflare'", stopBy: "end" },
      },
    }),
  );

  // 2. Remove wrangler import (only if it's the GetPlatformProxyOptions one)
  const wranglerImport = root.find({
    rule: { kind: "import_statement", has: { pattern: "'wrangler'", stopBy: "end" } },
  });
  if (wranglerImport?.text().includes("GetPlatformProxyOptions")) {
    removeNode(wranglerImport);
  }

  // 3. Remove fs import
  removeNode(root.find("import fs from $SRC"));

  // 4. Remove realpath and isCLI declarations
  removeNode(root.find("const realpath = $INIT"));
  removeNode(root.find("const isCLI = $INIT"));

  // 5. Replace cloudflare context assignment
  const cfAssign = root.find("const cloudflare = $INIT");
  if (cfAssign) {
    const r = cfAssign.range();
    const end = code.indexOf("\n", r.end.index) + 1 || r.end.index;
    edits.push({ start: r.start.index, end, replacement: "" });
  }

  // 6. Replace cloudflare.env.X → cfEnv.X
  for (const ref of root.findAll("cloudflare.env.$PROP")) {
    const prop = ref.getMatch("PROP")?.text();
    if (prop) {
      const r = ref.range();
      edits.push({ start: r.start.index, end: r.end.index, replacement: `cfEnv.${prop}` });
    }
  }

  // 7. Replace isCLI || !isProduction → !isProduction
  const cfRange = cfAssign?.range();
  for (const check of root.findAll("isCLI || !isProduction")) {
    const r = check.range();
    if (cfRange && r.start.index >= cfRange.start.index && r.end.index <= cfRange.end.index + 1) {
      continue;
    }
    edits.push({ start: r.start.index, end: r.end.index, replacement: "!isProduction" });
  }

  // 8. Remove getCloudflareContextFromWrangler function (+ preceding comments)
  const wranglerFn = root.find({
    rule: {
      kind: "function_declaration",
      has: { pattern: "getCloudflareContextFromWrangler", stopBy: "end" },
    },
  });
  if (wranglerFn) {
    let start = wranglerFn.range().start.index;
    while (start > 0) {
      const lineStart = code.lastIndexOf("\n", start - 2) + 1;
      const line = code.slice(lineStart, start).trim();
      if (line.startsWith("//")) {
        start = lineStart;
      } else {
        break;
      }
    }
    edits.push({ start, end: code.length, replacement: "" });
  }

  // Apply edits bottom-up
  edits.sort((a, b) => b.start - a.start);
  let result = code;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }

  // Add getCloudflareEnv function before export default
  if (!result.includes("function getCloudflareEnv")) {
    const fn = `\nasync function getCloudflareEnv() {
  try {
    const { env } = await import(/* @vite-ignore */ 'cloudflare:workers')
    return env
  } catch {
    const { getPlatformProxy } = await import('wrangler')
    const proxy = await getPlatformProxy({
      environment: process.env.CLOUDFLARE_ENV,
    })
    return proxy.env
  }
}\n\nconst cfEnv = await getCloudflareEnv()\n`;
    result = result.replace(/(\nexport default)/, fn + "$1");
  }

  result = result.replace(/\n{3,}/g, "\n\n");

  await helpers.write(configPath, result);
}

/** Replace OpenNext main with vinext entry and remove "remote": true for local dev. */
export async function fixWranglerForLocalDev(helpers: ReturnType<typeof createProjectHelpers>) {
  const wrangler = await helpers.read("wrangler.jsonc");
  await helpers.write(
    "wrangler.jsonc",
    wrangler
      .replace(/"main"\s*:\s*"\.open-next\/worker\.js"/g, '"main": "vinext/server/app-router-entry"')
      .replace(/"remote"\s*:\s*true,?\n?\s*/g, ""),
  );
}
