/**
 * E2E test: a collection with a lexical richText field.
 *
 * The Cloudflare D1 template ships only Media and Users, neither of which has a
 * richText field, so `payload generate:importmap` emits eight lines and the RSC
 * environment never reaches `@payloadcms/richtext-lexical`'s client entry. Any
 * real Payload project has richText somewhere, and that pulls the lexical client
 * graph into the worker entry's module graph — where
 * `@lexical/react/LexicalComposerContext` calls `createContext` at module scope
 * with no `'use client'` directive of its own.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertStatus,
	createProjectHelpers,
	runBuild,
	scaffoldCloudflareProject,
	startDevServer,
	startPreviewServer,
	waitForServerReady,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(import.meta.dirname, ".test-project-lexical");
const helpers = createProjectHelpers(TEST_DIR);

const ARTICLES_COLLECTION = `import type { CollectionConfig } from "payload";

export const Articles: CollectionConfig = {
	slug: "articles",
	admin: { useAsTitle: "title" },
	fields: [
		{ name: "title", type: "text", required: true },
		{ name: "body", type: "richText" },
	],
};
`;

async function scaffoldProject() {
	await scaffoldCloudflareProject(TEST_DIR, helpers, PLUGIN_ROOT);

	await helpers.write("src/collections/Articles.ts", ARTICLES_COLLECTION);

	const config = await helpers.read("src/payload.config.ts");
	await helpers.write(
		"src/payload.config.ts",
		config
			.replace(
				/^(import .*Users.*)$/m,
				`$1\nimport { Articles } from "./collections/Articles.ts";`,
			)
			.replace(/collections:\s*\[/, "collections: [Articles, "),
	);
}

describe("e2e: lexical richText collection", () => {
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

	it("generated an importMap that reaches the lexical client entry", async () => {
		const importMap = await helpers.read(
			"src/app/(payload)/admin/importMap.js",
		);

		expect(importMap).toContain("@payloadcms/richtext-lexical/client");
	});

	it("serves the collection's edit view", async () => {
		await assertStatus(
			server.port,
			"/admin/collections/articles/create",
			[200, 302, 307],
		);
	});

	// The lexical diff component imports getHTMLDiffComponents from
	// @payloadcms/ui/rsc, the re-export Rolldown has reported missing
	describe("production build", () => {
		let preview: Awaited<ReturnType<typeof startPreviewServer>>;

		beforeAll(async () => {
			await runBuild(helpers);
			preview = await startPreviewServer(TEST_DIR, helpers);
			await waitForServerReady(preview.proc, preview.port, "/admin");
		});

		afterAll(async () => {
			await preview?.kill();
		});

		it("builds an importMap that reaches the lexical diff component", async () => {
			const importMap = await helpers.read(
				"src/app/(payload)/admin/importMap.js",
			);

			expect(importMap).toContain(
				"@payloadcms/richtext-lexical/rsc#LexicalDiffComponent",
			);
		});

		it("the built Worker serves the collection's edit view", async () => {
			await assertStatus(
				preview.port,
				"/admin/collections/articles/create",
				[200, 302, 307],
			);
		});
	});
});
