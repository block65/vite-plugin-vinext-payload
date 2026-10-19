/**
 * E2E test: a project-owned worker entry that imports the Payload config.
 *
 * Every other suite runs the worker entry vinext's init picks,
 * `vinext/server/fetch-handler`, whose module graph reaches neither the Payload
 * config nor `@payloadcms/ui`. Wrapping that handler in a project entry — to add
 * instrumentation, or an auth gate in front of `/api/*` — is an ordinary thing to
 * do, and it changes what boots: `@cloudflare/vite-plugin` evaluates the whole
 * worker entry graph to read its export names, so everything the entry imports at
 * module scope now runs under the react-server condition before the server listens.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertStatus,
	createProjectHelpers,
	scaffoldCloudflareProject,
	startDevServer,
	waitForServerReady,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-custom-entry");
const helpers = createProjectHelpers(TEST_DIR);

// Mirrors the shape a consumer reported: the vinext handler re-exported behind a
// project entry, with the Payload config imported at module scope.
const WORKER_ENTRY = `import handler from "vinext/server/fetch-handler";
import config from "../src/payload.config.ts";

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
	// vinext's Cloudflare init points the worker at worker/index.ts when it exists
	await scaffoldCloudflareProject(TEST_DIR, helpers, PLUGIN_ROOT, () =>
		helpers.write("worker/index.ts", WORKER_ENTRY),
	);
	const cloudflareConfig = await helpers.read("cloudflare.config.ts");
	if (!cloudflareConfig.includes('entrypoint: "./worker/index.ts"')) {
		throw new Error(
			`init did not adopt the worker entry:\n${cloudflareConfig}`,
		);
	}
}

describe("e2e: project-owned worker entry", () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;

	beforeAll(async () => {
		await scaffoldProject();
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
