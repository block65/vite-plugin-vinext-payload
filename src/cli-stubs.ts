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
	pnpapi: dedent`
    export default undefined;
  `,
};

/**
 * Resolves CLI-only packages to no-op stubs.
 *
 * These packages are only used by `payload migrate` and
 * `payload generate:types` CLI commands, not at web runtime.
 */
export function payloadCliStubs(): Plugin {
	return {
		name: "vite-plugin-payload:cli-stubs",
		enforce: "pre",
		resolveId(id) {
			// Match bare specifier or any subpath import
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
