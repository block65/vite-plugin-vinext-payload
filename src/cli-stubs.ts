import type { Plugin } from "vite";
import { dedent } from "./dedent.ts";

const STUB_PREFIX = "\0payload-stub:";

const stubs: Record<string, string> = {
	"console-table-printer": dedent`
    export class Table {
      addRow() {}
      addRows() {}
      printTable() {}
    }
    export function printTable() {}
  `,
	"json-schema-to-typescript": dedent`
    export async function compile() { return ""; }
    export async function compileFromFile() { return ""; }
  `,
	// drizzle-kit bundles esbuild-register for CLI transpilation — not
	// needed at runtime since Vite handles all transpilation.
	"esbuild-register": dedent`
    export function register() { return { unregister() {} }; }
  `,
	// ws — Payload imports this for live-preview WebSocket server, which is
	// Next.js-specific and not used at RSC/SSR render time in vinext.
	// ws is CJS with an ESM wrapper; Vite resolves to wrapper.mjs then
	// follows relative imports into CJS files that break module interop.
	ws: dedent`
    export class WebSocket {
      constructor() { throw new Error("ws is not available in this environment"); }
    }
    export class WebSocketServer {
      constructor() { throw new Error("ws is not available in this environment"); }
    }
    export class Receiver {}
    export class Sender {}
    export function createWebSocketStream() {
      throw new Error("ws is not available in this environment");
    }
    export default WebSocket;
  `,
	// wrangler — payload.config's getCloudflareEnv falls back to
	// `import('wrangler')` → `getPlatformProxy` when `cloudflare:workers`
	// is unavailable, i.e. only under plain Node (payload CLI). Inside any
	// Vite environment the import must still *resolve*, and bundling it
	// drags wrangler's entire CLI into the graph — including blake3-wasm,
	// whose `./node.js` import Rolldown cannot resolve — killing both dev
	// dependency optimization and `vinext build` on the cloudflare target.
	// Throws on call, not import, so a genuine Node-side use stays loud.
	wrangler: dedent`
    export function getPlatformProxy() {
      throw new Error(
        "wrangler is stubbed at web runtime; getPlatformProxy is only available under plain Node (payload CLI)",
      );
    }
  `,
	pnpapi: dedent`
    export default undefined;
  `,
};

export interface PayloadCliStubsOptions {
	/**
	 * Names of Vite environments this stub resolver applies to. When
	 * undefined (the default used by `vinextPayload`), stubs apply to
	 * every environment. For `vinextPayloadWorker`, pass the worker env
	 * name so stubs don't intercept these specifiers in the parent app's
	 * `client` build — e.g. a website that legitimately imports
	 * `console-table-printer` from a non-Payload code path.
	 */
	envs?: string[];
}

/**
 * Resolves CLI-only packages to no-op stubs.
 *
 * These packages are only used by `payload migrate` and
 * `payload generate:types` CLI commands, not at web runtime.
 */
export function payloadCliStubs(options: PayloadCliStubsOptions = {}): Plugin {
	const { envs } = options;
	return {
		name: "vite-plugin-payload:cli-stubs",
		enforce: "pre",
		...(envs && {
			applyToEnvironment(env) {
				return envs.includes(env.name);
			},
		}),
		resolveId(id) {
			const pkg = Object.keys(stubs).find(
				(name) => id === name || id.startsWith(name + "/"),
			);
			if (pkg) {
				return STUB_PREFIX + pkg;
			}
		},
		load(id) {
			if (id.startsWith(STUB_PREFIX)) {
				return stubs[id.slice(STUB_PREFIX.length)];
			}
		},
	};
}
