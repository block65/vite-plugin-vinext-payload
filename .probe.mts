import { join } from "node:path";
import { chromium } from "playwright";
import { createProjectHelpers, startDevServer } from "./test/helpers.ts";

const TEST_DIR = join(
	"/home/mholman/Projects/block65/vinext-experimental/vite-plugin-vinext-payload/test",
	".test-project-admin",
);
const helpers = createProjectHelpers(TEST_DIR);
const server = await startDevServer(TEST_DIR, helpers);
console.log("port", server.port);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
	baseURL: `http://localhost:${server.port}`,
});
const home = await context.newPage();
await home.goto("/");
console.log("home title", await home.title());
console.log(
	"admin link count",
	await home.getByRole("link", { name: "Go to admin panel" }).count(),
);

const tabP = context.waitForEvent("page");
const t0 = Date.now();
await home.getByRole("link", { name: "Go to admin panel" }).click();
const tab = await tabP;
console.log("popup opened after", Date.now() - t0);
await tab.waitForLoadState("domcontentloaded");
console.log("dom after", Date.now() - t0, "url", tab.url());
try {
	await tab.getByLabel("Email").waitFor({ state: "visible", timeout: 60_000 });
	console.log("EMAIL FOUND after", Date.now() - t0);
} catch (e) {
	console.log("EMAIL NOT FOUND", (e as Error).message.slice(0, 200));
}
console.log("url now", tab.url());
const labels = await tab.locator("label").allTextContents();
console.log("labels", labels);
console.log("body", (await tab.locator("body").innerText()).slice(0, 800));

await browser.close();
await server.kill();
