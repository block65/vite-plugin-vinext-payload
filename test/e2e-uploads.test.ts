/**
 * E2E test: file uploads to a collection restricted by `upload.mimeTypes`.
 *
 * Payload sniffs the bytes with `file-type` and checks the result against
 * the allowlist; without detection every image falls back to the extension
 * lookup, which only knows text types, and is rejected. Runs on workerd under
 * `vite dev`.
 */

import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import {
	createProjectHelpers,
	fixWranglerForLocalDev,
	installVinextStack,
	rewritePayloadConfigForVinext,
	startDevServer,
	VERSIONS,
	waitForServerReady,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const JPEG = join(import.meta.dirname, "fixtures", "pixel.jpg");
const MIME_TYPES = "mimeTypes: ['image/jpeg', 'image/png']";

interface Upload {
	status: number;
	body: string;
}

async function restrictMediaMimeTypes(
	helpers: ReturnType<typeof createProjectHelpers>,
) {
	const media = await helpers.read("src/collections/Media.ts");
	const restricted = media.includes("upload: true,")
		? media.replace("upload: true,", `upload: { ${MIME_TYPES} },`)
		: media.replace("upload: {", `upload: {\n    ${MIME_TYPES},`);
	if (restricted === media) {
		throw new Error(`Media.ts has no upload config to restrict:\n${media}`);
	}
	await helpers.write("src/collections/Media.ts", restricted);
}

async function scaffoldCloudflareProject(
	testDir: string,
	helpers: ReturnType<typeof createProjectHelpers>,
) {
	await helpers.cleanup();
	await mkdir(testDir, { recursive: true });
	await helpers.npx([
		"--yes",
		"degit",
		"--force",
		`payloadcms/payload/templates/with-cloudflare-d1#v${VERSIONS.payload}`,
		testDir,
	]);
	await helpers.write(".env", `PAYLOAD_SECRET=${crypto.randomUUID()}\n`);
	await installVinextStack(helpers, PLUGIN_ROOT, "cloudflare");
	await rewritePayloadConfigForVinext(helpers);
	await fixWranglerForLocalDev(helpers);
}

// npm hoists file-type to the project root, where any module can import it;
// under pnpm only its dependents can. Placing it under them reproduces that,
// so an import the plugin leaves in a pre-bundled chunk fails as it does there
async function unhoistFileType(testDir: string) {
	const modules = join(testDir, "node_modules");
	await Promise.all(
		["payload", "@payloadcms/next"].map((dependent) =>
			cp(
				join(modules, "file-type"),
				join(modules, dependent, "node_modules", "file-type"),
				{ recursive: true },
			),
		),
	);
	await rm(join(modules, "file-type"), { recursive: true });
}

async function registerFirstUser(port: number) {
	const res = await fetch(`http://localhost:${port}/api/users/first-register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			email: `${crypto.randomUUID()}@example.com`,
			password: crypto.randomUUID(),
		}),
	});
	const body: unknown = await res.json();
	assert(
		res.ok &&
			typeof body === "object" &&
			body !== null &&
			"token" in body &&
			typeof body.token === "string",
		`first-register answered ${res.status}: ${JSON.stringify(body)}`,
	);
	return body.token;
}

async function uploadMedia(
	port: number,
	token: string,
	file: { name: string; type: string; bytes: Uint8Array<ArrayBuffer> },
): Promise<Upload> {
	const form = new FormData();
	form.append("file", new Blob([file.bytes], { type: file.type }), file.name);
	form.append("_payload", JSON.stringify({ alt: crypto.randomUUID() }));
	const res = await fetch(`http://localhost:${port}/api/media`, {
		method: "POST",
		headers: { authorization: `JWT ${token}` },
		body: form,
	});
	return { status: res.status, body: await res.text() };
}

async function uploadJpeg(port: number, token: string) {
	return uploadMedia(port, token, {
		name: `${crypto.randomUUID()}.jpg`,
		type: "image/jpeg",
		bytes: new Uint8Array(await readFile(JPEG)),
	});
}

function describeMimeTypeUploads(getPort: () => number) {
	let token: string;

	beforeAll(async () => {
		token = await registerFirstUser(getPort());
	});

	it("accepts a JPEG and stores the type detected from its bytes", async () => {
		const upload = await uploadJpeg(getPort(), token);

		expect(upload.status, upload.body).toBe(201);
		expect(JSON.parse(upload.body)).toMatchObject({
			doc: { mimeType: "image/jpeg", width: 4, height: 3 },
		});
	});

	// A browser types the part from the file name, so text renamed .jpg
	// arrives claiming image/jpeg; only the bytes give it away
	it("rejects text uploaded under a .jpg name", async () => {
		const upload = await uploadMedia(getPort(), token, {
			name: `${crypto.randomUUID()}.jpg`,
			type: "image/jpeg",
			bytes: new TextEncoder().encode(crypto.randomUUID()),
		});

		expect(upload.status, upload.body).toBe(400);
	});
}

describe("e2e: uploads on workerd", () => {
	const testDir = join(import.meta.dirname, ".test-project-uploads-workerd");
	const helpers = createProjectHelpers(testDir);
	let server: Awaited<ReturnType<typeof startDevServer>>;

	beforeAll(async () => {
		await scaffoldCloudflareProject(testDir, helpers);
		await restrictMediaMimeTypes(helpers);
		await helpers.npx(["vite-plugin-vinext-payload", "init"]);
		await helpers.npm(["install"]);
		await helpers.npx(["payload", "generate:importmap"]);
		await unhoistFileType(testDir);
		// The dev server cannot push a schema on this line: drizzle-kit is
		// stubbed in every mode, so the template's migrations create the tables
		await helpers.npx(["payload", "migrate"]);

		server = await startDevServer(testDir, helpers);
		await waitForServerReady(server.proc, server.port, "/admin");
	});

	afterAll(async () => {
		await server?.kill();
	});

	describeMimeTypeUploads(() => server.port);
});
