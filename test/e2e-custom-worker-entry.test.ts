/**
 * E2E test: a project-owned worker entry that imports the Payload config.
 *
 * Every other suite points wrangler's `main` at `vinext/server/app-router-entry`,
 * whose module graph is eighteen vinext modules and reaches neither the Payload
 * config nor `@payloadcms/ui`. Wrapping that handler in a project entry — to add
 * instrumentation, or an auth gate in front of `/api/*` — is an ordinary thing to
 * do, and it changes what boots: `@cloudflare/vite-plugin` evaluates the whole
 * worker entry graph to read its export names, so everything the entry imports at
 * module scope now runs under the react-server condition before the server listens.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertStatus,
	createProjectHelpers,
	fixWranglerForLocalDev,
	installVinextStack,
	rewritePayloadConfigForVinext,
	startDevServer,
	VERSIONS,
	waitForServerReady,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-custom-entry");
const helpers = createProjectHelpers(TEST_DIR);

// Mirrors the shape a consumer reported: the vinext handler re-exported behind a
// project entry, with the Payload config imported at module scope.
const WORKER_ENTRY = `import handler from "vinext/server/app-router-entry";
import config from "./payload.config.ts";

export default {
	async fetch(request, env, ctx) {
		if (!config) {
			return new Response("no config", { status: 500 });
		}
		return handler.fetch(request, env, ctx);
	},
};
`;

async function scaffoldProject() {
	await helpers.cleanup();
	const { mkdir } = await import("node:fs/promises");
	await mkdir(TEST_DIR, { recursive: true });
	await helpers.npx([
		"--yes",
		"degit",
		"--force",
		`payloadcms/payload/templates/with-cloudflare-d1#v${VERSIONS.payload}`,
		TEST_DIR,
	]);

	await writeFile(
		join(TEST_DIR, ".env"),
		`PAYLOAD_SECRET=${crypto.randomUUID()}\n`,
	);

	await installVinextStack(helpers, PLUGIN_ROOT, "cloudflare");

	await rewritePayloadConfigForVinext(helpers);
	await fixWranglerForLocalDev(helpers);

	await helpers.write("src/worker.ts", WORKER_ENTRY);

	const wrangler = await helpers.read("wrangler.jsonc");
	await helpers.write(
		"wrangler.jsonc",
		wrangler.replace(
			/"main"\s*:\s*"vinext\/server\/app-router-entry"/,
			'"main": "src/worker.ts"',
		),
	);
}

describe("e2e: project-owned worker entry", () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;

	beforeAll(async () => {
		await scaffoldProject();
		await helpers.npx(["vite-plugin-vinext-payload", "init"]);
		await helpers.npm(["install"]);
		await helpers.npx(["payload", "generate:importmap"]);

		server = await startDevServer(TEST_DIR, helpers);
		await waitForServerReady(server.proc, server.port, "/admin");
	});

	afterAll(async () => {
		await server?.kill();
	});

	it("serves the admin UI when the worker entry imports the Payload config", async () => {
		await assertStatus(server.port, "/admin", [200, 302, 307]);
	});
});
