/**
 * Unit tests for `waitForServerReady`.
 *
 * The e2e suites call this before their first assertion, so when it returns
 * early every downstream failure looks like a product bug. `assertStatus`
 * deliberately does not retry, which makes an early return here surface as an
 * unexplainable 500 somewhere else entirely.
 *
 * The failure mode under test: on a cold dependency cache the priming request
 * is reset *because* the module runner is restarting mid-optimization. Treating
 * that reset as a ready signal returns a server that cannot yet serve.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { waitForServerReady } from "./helpers.ts";

/** Vite's line when a re-optimization completes and the runner reloads. */
const OPTIMIZER_LINE = "optimized dependencies changed. reloading\n";

/**
 * A process whose stdout/stderr can be driven from the test. `waitForOutput`
 * only ever calls `setEncoding`/`on`/`off` on those two streams.
 */
function fakeProc() {
	const stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
	const stderr = Object.assign(new EventEmitter(), { setEncoding() {} });

	return { stdout, stderr } as unknown as ChildProcess;
}

const openServers = new Set<Server>();

afterEach(async () => {
	await Promise.all(
		[...openServers].map(
			(server) => new Promise<void>((resolve) => server.close(() => resolve())),
		),
	);
	openServers.clear();
});

/** Listen on an ephemeral port and resolve once the port is known. */
async function listen(
	handler: (socket: import("node:net").Socket) => void,
): Promise<number> {
	const server = createServer();
	openServers.add(server);
	server.on("connection", handler);

	const port = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error(`expected a TCP address, got ${String(address)}`));
				return;
			}
			resolve(address.port);
		});
	});

	return port;
}

it("does not report ready while a reset priming request leaves optimization in flight", async () => {
	// Destroying the socket reproduces the runner tearing down mid-request.
	const port = await listen((socket) => socket.destroy());
	const proc = fakeProc();

	let resolved = false;
	const ready = waitForServerReady(proc, port, "/").then((outcome) => {
		resolved = true;
		return outcome;
	});

	// The reset lands well inside this window; the optimizer line has not.
	await expect.poll(() => resolved, { timeout: 1_000 }).toBe(false);

	proc.stdout?.emit("data", OPTIMIZER_LINE);

	await expect(ready).resolves.toBe("optimized");
});

it("reports ready on the priming response when the cache is already warm", async () => {
	const port = await listen((socket) => {
		socket.on("data", () => {
			socket.end(
				"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
			);
		});
	});

	const outcome = await waitForServerReady(fakeProc(), port, "/");

	expect(outcome).toBe("served");
});

it("surfaces the timeout rather than reporting ready when nothing settles", async () => {
	const port = await listen((socket) => socket.destroy());

	await expect(waitForServerReady(fakeProc(), port, "/", 500)).rejects.toThrow(
		/Timed out waiting for/,
	);
});
