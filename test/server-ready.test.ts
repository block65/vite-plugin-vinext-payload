/**
 * Unit tests for `waitForServerReady`.
 *
 * The e2e suites call this before their first assertion, so when it reports
 * ready too early every downstream failure looks like a product bug.
 * `assertStatus` deliberately does not retry, which makes an early return here
 * surface as an unexplainable 500 somewhere else entirely.
 *
 * The failure modes under test are the ones a cold start actually produces: a
 * connection reset while the module runner restarts, and a 500 served during
 * dependency optimization. Neither means the server is up.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { respondsAtAll, waitForServerReady } from "./helpers.ts";

/**
 * A process the test can drive. `waitForServerReady` only subscribes to
 * `exit`; the streams exist because `startDevServer` shares the type.
 */
function fakeProc() {
	const proc = new EventEmitter() as unknown as ChildProcess;
	return proc;
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

/** Listen on an ephemeral port, handling each connection with `handler`. */
async function listen(handler: (socket: Socket) => void): Promise<number> {
	const server = createServer();
	openServers.add(server);
	server.on("connection", handler);

	return new Promise<number>((resolve, reject) => {
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
}

/** Reply with `status`, then close. */
function respond(socket: Socket, status: number) {
	socket.end(
		`HTTP/1.1 ${status} X\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok`,
	);
}

it("keeps waiting while the server answers with a 500", async () => {
	// Optimization is still running: the route exists but cannot render yet.
	let attempts = 0;
	const port = await listen((socket) => {
		socket.on("data", () => {
			attempts += 1;
			respond(socket, attempts < 3 ? 500 : 307);
		});
	});

	const status = await waitForServerReady(fakeProc(), port, "/admin");

	expect(status).toBe(307);
	expect(attempts).toBe(3);
});

it("keeps waiting while the connection is reset mid-restart", async () => {
	let attempts = 0;
	const port = await listen((socket) => {
		attempts += 1;
		if (attempts < 3) {
			socket.destroy();
			return;
		}
		socket.on("data", () => respond(socket, 200));
	});

	const status = await waitForServerReady(fakeProc(), port, "/");

	expect(status).toBe(200);
});

// The RPC payload suite asserts on an error body, so a persistent 500 there is
// the result under test rather than a server that never started.
it("reports ready on a persistent 500 when told any response counts", async () => {
	const port = await listen((socket) => {
		socket.on("data", () => respond(socket, 500));
	});

	const status = await waitForServerReady(fakeProc(), port, "/", {
		timeoutMs: 2_000,
		ready: respondsAtAll,
	});

	expect(status).toBe(500);
});

it("reports the last status seen when the route never recovers", async () => {
	const port = await listen((socket) => {
		socket.on("data", () => respond(socket, 503));
	});

	await expect(
		waitForServerReady(fakeProc(), port, "/admin", { timeoutMs: 1_000 }),
	).rejects.toThrow(/never became ready at \/admin.*HTTP 503/s);
});

it("fails immediately when the server process dies", async () => {
	const port = await listen((socket) => socket.destroy());
	const proc = fakeProc();

	const ready = waitForServerReady(proc, port, "/", { timeoutMs: 60_000 });
	proc.emit("exit", 1, null);

	// The 60s timeout would still be running; this resolves on the exit signal.
	await expect(ready).rejects.toThrow(/died before becoming ready/);
});
