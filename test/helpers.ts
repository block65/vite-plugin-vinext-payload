import {
	execFile as execFileCb,
	spawn,
	type ChildProcess,
} from "node:child_process";
import {
	readFile,
	writeFile,
	mkdir,
	mkdtemp,
	rm,
	access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/** Known-good version pins for testing. */
export const VERSIONS = {
	payload: "3.91.0",
	vinext: "1.2.1",
	vite: "8.3.4",
	// react-server-dom-webpack ships in lockstep with React and carries a caret
	// peer on its exact minor, so these three move together or not at all.
	react: "19.3.1",
	vitePluginReact: "^6.0.1",
	// The template's own vitest pin (4.0.x) has a vite peer range ending at 7.
	vitest: "^4.1.11",
} as const;

const execFile = promisify(execFileCb);

/**
 * Env for scaffolding child processes, with vitest's own markers stripped.
 *
 * vitest sets `VITEST=true` (and `VITEST_*`) in the runner's `process.env`,
 * which child processes would otherwise inherit. Recent `degit` releases
 * short-circuit their CLI when `process.env.VITEST` is set
 * (`process.env.VITEST || main(argv)`), so `npx degit` silently does nothing —
 * scaffolding produces no files. Strip these so spawned tools behave as they
 * would outside the test runner.
 */
export const childEnv: NodeJS.ProcessEnv = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
);

/**
 * Ceiling for a single readiness poll. A request that cold optimization holds
 * open can outlive the entire readiness window — abandoning it keeps the gate
 * polling instead of reducing it to one attempt.
 */
const READY_ATTEMPT_TIMEOUT_MS = 10_000;

/** How much trailing server output a failed readiness gate reports. */
const SERVER_OUTPUT_TAIL_CHARS = 2_000;

export function createProjectHelpers(testDir: string) {
	async function run(cmd: string, args: string[], cwd = testDir) {
		const { stdout } = await execFile(cmd, args, {
			cwd,
			timeout: 300_000,
			env: childEnv,
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
		cleanup: () =>
			rm(testDir, { recursive: true, force: true }).catch(() => {}),
	};
}

// E2E_DISABLE_PLUGINS: comma-separated vinextPayload() sub-plugin names, or `all`
async function disableNamedPlugins(
	helpers: ReturnType<typeof createProjectHelpers>,
) {
	const disabled = process.env.E2E_DISABLE_PLUGINS?.trim();
	if (!disabled) {
		return;
	}
	const configPath = (await helpers.exists("vite.config.ts"))
		? "vite.config.ts"
		: "vite.config.mts";
	const config = await helpers.read(configPath);
	const filter =
		disabled === "all"
			? "vinextPayload().filter(() => false)"
			: `vinextPayload().filter((p) => !${JSON.stringify(disabled.split(","))}.includes(p.name))`;
	// Lookahead keeps a second call from wrapping an already-filtered config
	const rewritten = config.replace(/vinextPayload\(\)(?!\.filter)/, filter);
	if (rewritten === config && !config.includes("vinextPayload().filter")) {
		throw new Error(
			`E2E_DISABLE_PLUGINS set but ${configPath} has no vinextPayload()`,
		);
	}
	await helpers.write(configPath, rewritten);
}

export async function runBuild(
	helpers: ReturnType<typeof createProjectHelpers>,
) {
	await disableNamedPlugins(helpers);
	const pkg = JSON.parse(await helpers.read("package.json"));
	const script = pkg.scripts["build:vinext"] ? "build:vinext" : "build";
	return helpers.npm(["run", script]);
}

/**
 * Start a dev server, wait for it to print a port, return port + kill function.
 *
 * 60s is deliberate. A dev server that needs longer than this to become usable
 * is broken, not slow — do not raise the ceiling to make a boot fit under it.
 */
export async function startDevServer(
	testDir: string,
	helpers: ReturnType<typeof createProjectHelpers>,
	readyTimeoutMs = 60_000,
) {
	await disableNamedPlugins(helpers);
	const pkg = JSON.parse(await helpers.read("package.json"));
	const script = pkg.scripts["dev:vinext"] ? "dev:vinext" : "dev";

	const proc = spawn("npm", ["run", script], {
		cwd: testDir,
		stdio: "pipe",
		env: {
			...childEnv,
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
			readyTimeoutMs,
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

	return { port, proc, kill, [Symbol.asyncDispose]: kill };
}

/** Wait for a spawned process's stdout *or* stderr to match a pattern. */
export function waitForOutput(
	proc: ChildProcess,
	pattern: RegExp,
	timeoutMs = 60_000,
) {
	proc.stdout?.setEncoding("utf8");
	proc.stderr?.setEncoding("utf8");

	return new Promise<RegExpMatchArray>((resolve, reject) => {
		let output = "";
		const timeout = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`Timed out waiting for ${pattern}. Output:\n${output.slice(-500)}`,
				),
			);
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

interface ReadyOptions {
	/**
	 * Matches `startDevServer`'s boot ceiling deliberately. Cold-start
	 * optimization of the full Payload graph measures ~22s; a server still
	 * unable to answer at 60 is broken, not slow. Raising this to fit a slow
	 * run converts a diagnosis into two minutes of waiting for the same
	 * failure.
	 */
	timeoutMs?: number;
	/** Given a response status, has the server finished starting? */
	ready?: (status: number) => boolean;
}

/**
 * Ready once the route renders. A 5xx during startup is the module runner
 * restarting, not a verdict on the route.
 */
export const rendersWithoutError = (status: number) => status < 500;

/**
 * Ready as soon as anything answers, whatever the status.
 *
 * For endpoints where an error response is the result under test — a worker
 * that reports its init failure in the body, say — the status carries no
 * readiness information, so the only thing left to wait for is the socket
 * answering at all.
 */
export const respondsAtAll = () => true;

/**
 * Wait until the dev server is genuinely able to serve requests.
 *
 * `startDevServer` resolves on Vite's `Local:` line, which only means the
 * socket is listening. The first request is what *triggers* optimization of
 * the whole dependency graph, and Vite tears down and restarts the module
 * runner when that completes — requests landing in that window are reset or
 * answered with a 500 that has nothing to do with the code under test.
 *
 * There is no event to wait on. Vite logs nothing at all during a cold start:
 * its "optimized dependencies changed" line is emitted only when a *later*
 * re-optimization invalidates an existing cache, so a matcher watching for it
 * never fires here. The endpoint is the only signal the server actually gives,
 * so this asks it until it stops erroring.
 *
 * That is a readiness gate, not a retry hiding a flake — no assertion is
 * relaxed. Callers still assert their real contract exactly once, against a
 * server that has demonstrably finished starting. A route that is genuinely
 * broken keeps returning 5xx and this times out naming the status it kept
 * seeing.
 *
 * `ready` decides what counts. The default suits routes expected to render:
 * a 5xx is startup noise, worth waiting through. It does not suit a test
 * whose subject *is* an error response — pass `respondsAtAll` there, or the
 * gate waits out the timeout on the very result being asserted.
 */
export async function waitForServerReady(
	proc: ChildProcess,
	port: number,
	path = "/",
	{ timeoutMs = 60_000, ready = rendersWithoutError }: ReadyOptions = {},
) {
	// A dead server will never become ready; without this the caller waits out
	// the full timeout to be told something the process already knew.
	let exit: string | undefined;
	proc.once("exit", (code, signal) => {
		exit = `process exited (code ${code}, signal ${signal})`;
	});

	// "HTTP 500" alone says nothing about a boot failure; the server's own
	// output does. Keep the tail for the gate's failure messages.
	proc.stdout?.setEncoding("utf8");
	proc.stderr?.setEncoding("utf8");
	let output = "";
	const onData = (chunk: string) => {
		output = (output + chunk).slice(-SERVER_OUTPUT_TAIL_CHARS);
	};
	proc.stdout?.on("data", onData);
	proc.stderr?.on("data", onData);

	const fail = (message: string) =>
		new Error(
			output.length > 0
				? `${message}\nServer output tail:\n${output}`
				: message,
		);

	const deadline = Date.now() + timeoutMs;
	let last = "no response yet";

	try {
		/* oxlint-disable no-await-in-loop -- each attempt must observe the result of
		   the one before it; running them concurrently would hammer a starting
		   server with requests it cannot answer and defeat the point of the gate. */
		while (Date.now() < deadline) {
			if (exit !== undefined) {
				throw fail(`Server died before becoming ready at ${path}: ${exit}`);
			}

			try {
				const res = await fetch(`http://localhost:${port}${path}`, {
					redirect: "manual",
					signal: AbortSignal.timeout(READY_ATTEMPT_TIMEOUT_MS),
				});
				// Drain the body so the socket closes rather than leaking into the
				// next attempt.
				await res.text();

				if (ready(res.status)) {
					return res.status;
				}

				last = `HTTP ${res.status}`;
			} catch (error) {
				// Expected while the runner restarts mid-flight: the connection is
				// reset, or a cold-optimization hang hits the attempt ceiling. Any
				// other cause shows up in the timeout message below.
				last = error instanceof Error ? error.message : String(error);
			}

			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		/* oxlint-enable no-await-in-loop */

		throw fail(
			`Server never became ready at ${path} within ${timeoutMs}ms (last: ${last})`,
		);
	} finally {
		proc.stdout?.off("data", onData);
		proc.stderr?.off("data", onData);
	}
}

/**
 * Fetch a route from the dev server and assert the status code.
 *
 * Single request, no retry: the server is expected to be ready before this is
 * called (see `waitForServerReady`). A wrong status here is a real result, not
 * something to poll past.
 */
export async function assertStatus(
	port: number,
	path: string,
	expected: number[],
) {
	const res = await fetch(`http://localhost:${port}${path}`, {
		redirect: "manual",
	});

	if (!expected.includes(res.status)) {
		throw new Error(
			`GET ${path} expected ${expected.join("|")}, got ${res.status}`,
		);
	}

	return res;
}

// ── Fixtures ───────────────────────────────────────────────────────

export const FIXTURES = {
	packageJson: JSON.stringify(
		{
			name: "test-project",
			dependencies: { payload: `^${VERSIONS.payload}` },
			// Exact, not `^`: the plugin peer-pins vinext exactly, and
			// `^1.0.0-beta.2` would float across all of 1.x.
			devDependencies: { vinext: VERSIONS.vinext },
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

	// The exact shape `vinext init --platform=cloudflare` writes on 1.0:
	// vinext() takes an options object and spans multiple lines. The init
	// matcher missing this shape is how the D1 e2e ran without the plugin.
	viteConfigVinextArgs: `import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";

export default defineConfig({
  plugins: [
    vinext({
      cache: { cdn: cdnAdapter() },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
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

	// Payload's current template: stylesheet renamed to .css and a viewport
	// export added (payloadcms/payload#17464 and after). Anything the layout
	// rewrite hardcodes rather than preserves shows up as a diff against this.
	originalLayoutCurrent: `/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
/* DO NOT MODIFY IT BECAUSE IT COULD BE REWRITTEN AT ANY TIME. */
import config from '@payload-config'
import '@payloadcms/next/css'
import type { ServerFunctionClient } from 'payload'
import {
  generatePayloadViewport,
  handleServerFunctions,
  RootLayout,
} from '@payloadcms/next/layouts'
import React from 'react'

import { importMap } from './admin/importMap.js'
import './custom.css'

export const generateViewport = generatePayloadViewport

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
	options?: { wranglerConfig?: boolean; layout?: string },
) {
	const { write, cleanup } = createProjectHelpers(testDir);
	await cleanup();
	await write("package.json", FIXTURES.packageJson);
	await write("vite.config.ts", viteConfig);
	await write("tsconfig.json", FIXTURES.tsconfig);
	await write(
		"src/app/(payload)/layout.tsx",
		options?.layout ?? FIXTURES.originalLayout,
	);
	await write(
		"src/app/(payload)/admin/[[...segments]]/page.tsx",
		FIXTURES.originalPage,
	);
	if (options?.wranglerConfig) {
		await write("wrangler.jsonc", '{ "name": "test" }');
	}
}

/**
 * Pack the plugin and return the tarball path, so scaffolds install what a
 * consumer installs.
 *
 * `npm install -D <dir>` symlinks the directory. Resolution then walks through
 * that link into this repo's own node_modules, putting a second copy of React
 * on the scaffold's module graph — the classic cause of intermittent RSC
 * failures, and invisible in the manifest because nothing declares it. Packing
 * copies in only what `files` publishes.
 *
 * It also means the suites exercise the published artifact rather than the
 * working tree: a file missing from `files` fails here instead of after
 * release.
 */
export async function packPlugin(pluginRoot: string) {
	const destination = await mkdtemp(join(tmpdir(), "vinext-payload-pack-"));

	// npm pack runs `prepare`, so the tarball always carries a current build.
	const { stdout } = await execFile(
		"npm",
		["pack", "--pack-destination", destination, "--silent"],
		{ cwd: pluginRoot, env: childEnv, timeout: 300_000 },
	);

	const tarball = stdout.trim().split("\n").at(-1);
	if (!tarball) {
		throw new Error(`npm pack produced no tarball in ${pluginRoot}`);
	}

	return join(destination, tarball);
}

/**
 * Rewrite the degit'd template's pins so the dependency graph resolves and
 * the suite runs the versions it claims to.
 *
 * Payload's templates lag its releases, so the one tagged `v3.88.0` still
 * pins `payload@3.84.1`; every `payload` / `@payloadcms/*` entry is moved
 * onto `VERSIONS.payload`. The template also targets Next.js, so it pins
 * versions vinext cannot accept: `@vitejs/plugin-react@4` against vinext's
 * `^5.1.4 || ^6.0.0`, `vitest@4.0` whose vite peer stops at 7, and React one
 * patch below what `react-server-dom-webpack` requires — vinext installs the
 * RSC runtime, and each of its releases carries a caret peer on the matching
 * React, so `19.2.6` does not satisfy `^19.2.7`.
 *
 * Aligning the pins here is what lets every install in this file run with a
 * strict resolver. The alternative — telling the package manager to ignore
 * peer conflicts — hides real breakage: it would equally happily install a
 * React that genuinely does not work with the RSC runtime under test.
 */
async function alignTemplatePins(
	helpers: ReturnType<typeof createProjectHelpers>,
) {
	const pkg = JSON.parse(await helpers.read("package.json"));

	const isPayloadPackage = (name: string) =>
		name === "payload" || name.startsWith("@payloadcms/");
	pkg.dependencies = {
		...Object.fromEntries(
			Object.entries(pkg.dependencies ?? {}).map(([name, version]) => [
				name,
				isPayloadPackage(name) ? VERSIONS.payload : version,
			]),
		),
		react: VERSIONS.react,
		"react-dom": VERSIONS.react,
		"react-server-dom-webpack": VERSIONS.react,
	};

	if (pkg.devDependencies?.["@vitejs/plugin-react"]) {
		pkg.devDependencies["@vitejs/plugin-react"] = VERSIONS.vitePluginReact;
	}
	if (pkg.devDependencies?.vitest) {
		pkg.devDependencies.vitest = VERSIONS.vitest;
	}

	await helpers.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Install deps, run vinext init, install the plugin.
 *
 * --ignore-scripts: sharp has no prebuilt binary for Node 24 and
 *   falls back to a source build requiring node-addon-api.
 */
export async function installVinextStack(
	helpers: ReturnType<typeof createProjectHelpers>,
	pluginRoot: string,
	platform: "cloudflare" | "node" = "node",
) {
	// Before any install: `vinext init` runs its own install internally, which
	// takes no flags from us. The pins have to be correct in the manifest by
	// the time it runs.
	await alignTemplatePins(helpers);
	await helpers.npm(["install", "--ignore-scripts"]);
	await helpers.npm(["rebuild", "esbuild"]);
	// Pin vinext to the exact version we peer-pin. Installing it unpinned
	// resolves to whatever the `latest` dist-tag points at, which may not be
	// the version this plugin supports — the e2e suite would then be testing
	// a stack we make no claims about.
	await helpers.npm([
		"install",
		"-D",
		`vinext@${VERSIONS.vinext}`,
		`vite@${VERSIONS.vite}`,
	]);
	// vinext 1.0 requires an explicit deployment target; it used to infer one.
	// The cloudflare target additionally demands cache/image choices. These are
	// the minimal options — the suite exercises Payload, not vinext's CDN cache.
	await helpers.npx([
		"vinext",
		"init",
		`--platform=${platform}`,
		...(platform === "cloudflare"
			? [
					"--cdn-cache=workers-cache",
					"--data-cache=none",
					"--image-optimization=none",
				]
			: []),
	]);
	// init rewrites both to caret ranges; put the exact pins back
	await helpers.npm([
		"install",
		"-D",
		"--save-exact",
		`vinext@${VERSIONS.vinext}`,
		`vite@${VERSIONS.vite}`,
	]);
	await helpers.npm(["install", "-D", await packPlugin(pluginRoot)]);
	await addVinextPayload(helpers);
}

/**
 * Add `vinextPayload()` after the `vinext(...)` call `vinext init` wrote —
 * the one line the README asks users to add.
 */
async function addVinextPayload(
	helpers: ReturnType<typeof createProjectHelpers>,
) {
	const { parse, Lang } = await import("@ast-grep/napi");
	const config = await helpers.read("vite.config.ts");
	const call = parse(Lang.TypeScript, config).root().find("vinext($$$)");
	if (!call) {
		throw new Error(`vite.config.ts has no vinext() call:\n${config}`);
	}
	const end = call.range().end.index;
	const withPlugin = config.startsWith(",", end)
		? `${config.slice(0, end + 1)}\n    vinextPayload(),${config.slice(end + 1)}`
		: `${config.slice(0, end)}, vinextPayload()${config.slice(end)}`;
	await helpers.write(
		"vite.config.ts",
		withPlugin.replace(
			/^(import vinext from "vinext";)$/m,
			'$1\nimport vinextPayload from "vite-plugin-vinext-payload";',
		),
	);
}

/**
 * The Payload `with-cloudflare-d1` template moved onto vinext's default
 * Cloudflare setup: OpenNext removed, `vinext init --platform=cloudflare`,
 * and the template's bindings declared in the `cloudflare.config.ts` it
 * generates. `beforeInit` runs once the template is in place, for files
 * init should see (a `worker/index.ts` entry).
 */
export async function scaffoldCloudflareProject(
	testDir: string,
	helpers: ReturnType<typeof createProjectHelpers>,
	pluginRoot: string,
	beforeInit?: () => Promise<void>,
) {
	await helpers.cleanup();
	await mkdir(testDir, { recursive: true });
	await helpers.npx([
		"--yes",
		"degit",
		"--force",
		// Pinned to the release tag: `main` carries the next major's templates,
		// which import exports the pinned packages do not have.
		`payloadcms/payload/templates/with-cloudflare-d1#v${VERSIONS.payload}`,
		testDir,
	]);
	await helpers.write(".env", `PAYLOAD_SECRET=${crypto.randomUUID()}\n`);

	// vinext's Cloudflare init refuses to replace a Wrangler config
	const pkg = JSON.parse(await helpers.read("package.json"));
	for (const name of ["@opennextjs/cloudflare", "wrangler"]) {
		delete pkg.dependencies?.[name];
		delete pkg.devDependencies?.[name];
	}
	await helpers.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
	await rm(join(testDir, "wrangler.jsonc"));
	await rm(join(testDir, "open-next.config.ts"));
	await rewritePayloadConfigForVinext(helpers);
	await beforeInit?.();

	await installVinextStack(helpers, pluginRoot, "cloudflare");

	const cloudflareConfig = await helpers.read("cloudflare.config.ts");
	const anchor = "ASSETS: bindings.assets(),";
	if (!cloudflareConfig.includes(anchor)) {
		throw new Error(
			`cloudflare.config.ts has no ${anchor}:\n${cloudflareConfig}`,
		);
	}
	await helpers.write(
		"cloudflare.config.ts",
		cloudflareConfig.replace(
			anchor,
			`${anchor}\n      D1: bindings.d1(),\n      R2: bindings.r2(),\n      PAYLOAD_SECRET: bindings.secret(),`,
		),
	);
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

	const removeNode = (
		node: ReturnType<typeof root.find>,
		includeTrailingNewline = true,
	) => {
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
		rule: {
			kind: "import_statement",
			has: { pattern: "'wrangler'", stopBy: "end" },
		},
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
			edits.push({
				start: r.start.index,
				end: r.end.index,
				replacement: `cfEnv.${prop}`,
			});
		}
	}

	// 7. Replace isCLI || !isProduction → !isProduction
	const cfRange = cfAssign?.range();
	for (const check of root.findAll("isCLI || !isProduction")) {
		const r = check.range();
		if (
			cfRange &&
			r.start.index >= cfRange.start.index &&
			r.end.index <= cfRange.end.index + 1
		) {
			continue;
		}
		edits.push({
			start: r.start.index,
			end: r.end.index,
			replacement: "!isProduction",
		});
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
		result =
			result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
	}

	if (!result.includes("function getCloudflareEnv")) {
		const fn = `\nasync function getCloudflareEnv() {
  try {
    const { env } = await import(/* @vite-ignore */ 'cloudflare:workers')
    return env
  } catch {
    // Payload's Node CLI: no bindings outside workerd
    return {} as CloudflareEnv
  }
}\n\nconst cfEnv = await getCloudflareEnv()\n`;
		result = result.replace(/(\nexport default)/, fn + "$1");
	}

	result = result.replace(/\n{3,}/g, "\n\n");

	await helpers.write(configPath, result);
}
