import { mkdir, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { JevBrowserManager } from "./runtime.ts";
import type { BrowserAction } from "./types.ts";

export const JB_DIR = join(homedir(), ".jb");
export const SOCK_PATH = join(JB_DIR, "jb.sock");
export const PID_PATH = join(JB_DIR, "jb.pid");

type JsonObject = Record<string, unknown>;

interface RpcRequest {
	id?: unknown;
	method?: unknown;
	session?: unknown;
	params?: unknown;
}

interface HostUpdate {
	type?: string;
	payload?: unknown;
}

type HostBridge = { emitEvent?: (name: string, payload?: unknown) => void };

const manager = new JevBrowserManager();
const knownSessions = new Set<string>(["default"]);

let server: net.Server | undefined;
let exiting = false;
let currentClient: { socket: net.Socket; id: string } | undefined;

function errCode(err: unknown): string | undefined {
	if (err && typeof err === "object" && "code" in err) {
		return String((err as { code: unknown }).code);
	}
	return undefined;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function writeJson(socket: net.Socket, value: unknown): void {
	if (socket.destroyed || !socket.writable) return;
	try {
		socket.write(`${JSON.stringify(value)}\n`);
	} catch {
		/* client gone */
	}
}

function writeJsonFlushed(socket: net.Socket, value: unknown): Promise<void> {
	return new Promise((resolve) => {
		if (socket.destroyed || !socket.writable) {
			resolve();
			return;
		}
		try {
			socket.write(`${JSON.stringify(value)}\n`, () => resolve());
		} catch {
			resolve();
		}
	});
}

function formatJevStep(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "jev-step";
	const step = payload as {
		step?: unknown;
		status?: unknown;
		operation?: unknown;
		target?: unknown;
	};
	const parts = [
		`step ${step.step ?? "?"}`,
		step.status,
		step.operation,
	].filter((part) => part !== undefined && part !== "");
	if (typeof step.target === "string" && step.target) {
		parts.push(`"${step.target}"`);
	}
	return parts.join(" ");
}

function installHostBridge(): void {
	const host = globalThis as typeof globalThis & {
		__jbHost?: HostBridge;
	};
	host.__jbHost = {
		emitEvent(name, body) {
			const client = currentClient;
			if (!client || name !== "jev_browser_update") return;
			const update = (body ?? {}) as HostUpdate;
			const type = update.type;
			if (!type) return;
			writeJson(client.socket, {
				id: client.id,
				type: "event",
				event: type,
				payload: update.payload,
			});
			if (type === "jev-step") {
				writeJson(client.socket, {
					id: client.id,
					type: "log",
					line: formatJevStep(update.payload),
				});
			}
		},
	};
}

async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (err) {
		if (errCode(err) !== "ENOENT") throw err;
	}
}

async function cleanupAndExit(code = 0): Promise<void> {
	if (exiting) return;
	exiting = true;
	currentClient = undefined;
	// Drop the socket first so a following `jb run` cannot attach to this
	// process while it is still tearing down the browser.
	await unlinkIfPresent(SOCK_PATH).catch(() => undefined);
	await unlinkIfPresent(PID_PATH).catch(() => undefined);
	for (const sessionId of [...knownSessions]) {
		await manager.stop({ sessionId }).catch(() => undefined);
	}
	await new Promise<void>((resolve) => {
		if (!server?.listening) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, 2000);
		server.close(() => {
			clearTimeout(timer);
			resolve();
		});
	});
	process.exit(code);
}

async function dispatch(
	method: string,
	params: JsonObject,
	sessionId: string,
): Promise<unknown> {
	const context = { sessionId };
	knownSessions.add(sessionId);
	switch (method) {
		case "run":
			return manager.run(params as { goal: string }, context);
		case "reply":
			return manager.reply(
				{
					text: typeof params.text === "string" ? params.text : "",
					maxSteps:
						typeof params.maxSteps === "number" ? params.maxSteps : undefined,
				},
				context,
			);
		case "actions":
			return manager.actions(
				params as { actions: BrowserAction[]; includeScreenshot?: boolean },
				context,
			);
		case "state":
			return manager.state(context);
		case "logs":
			return manager.logs(
				{
					afterId:
						typeof params.afterId === "number" ? params.afterId : undefined,
					limit: typeof params.limit === "number" ? params.limit : undefined,
				},
				context,
			);
		case "stream": {
			const action = params.action;
			if (action !== "start" && action !== "status" && action !== "stop") {
				throw new Error('stream action must be "start", "status", or "stop"');
			}
			return manager.stream(
				{
					action,
					intervalMs:
						typeof params.intervalMs === "number"
							? params.intervalMs
							: undefined,
				},
				context,
			);
		}
		case "stop":
		case "shutdown":
			return manager.stop(context);
		default:
			throw new Error(`unknown method: ${method}`);
	}
}

async function handleRequest(socket: net.Socket, line: string): Promise<void> {
	let req: RpcRequest;
	try {
		req = JSON.parse(line) as RpcRequest;
	} catch (err) {
		writeJson(socket, {
			id: "?",
			type: "error",
			ok: false,
			message: `invalid JSON: ${errMessage(err)}`,
		});
		return;
	}

	const id = req.id === undefined ? "1" : String(req.id);
	const method = typeof req.method === "string" ? req.method : "";
	const sessionId =
		typeof req.session === "string" && req.session ? req.session : "default";
	const params =
		req.params && typeof req.params === "object" && !Array.isArray(req.params)
			? (req.params as JsonObject)
			: {};

	currentClient = { socket, id };
	try {
		if (!method) throw new Error("missing method");
		const data = await dispatch(method, params, sessionId);
		await writeJsonFlushed(socket, { id, type: "result", ok: true, data });
		if (method === "stop" || method === "shutdown") {
			socket.end();
			await cleanupAndExit(0);
		}
	} catch (err) {
		await writeJsonFlushed(socket, {
			id,
			type: "error",
			ok: false,
			message: errMessage(err),
		});
	} finally {
		if (currentClient?.socket === socket && currentClient.id === id) {
			currentClient = undefined;
		}
	}
}

function attachSocket(socket: net.Socket): void {
	let buf = "";
	let queue = Promise.resolve();
	socket.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) {
				queue = queue
					.then(() => handleRequest(socket, line))
					.catch((err) => {
						writeJson(socket, {
							id: "?",
							type: "error",
							ok: false,
							message: errMessage(err),
						});
					});
			}
			nl = buf.indexOf("\n");
		}
	});
	socket.on("error", () => undefined);
}

export async function startDaemon(): Promise<void> {
	await mkdir(JB_DIR, { recursive: true });
	await unlinkIfPresent(SOCK_PATH);
	installHostBridge();

	server = net.createServer(attachSocket);

	await new Promise<void>((resolve, reject) => {
		server!.once("error", (err) => {
			if (errCode(err) === "EADDRINUSE") {
				process.exit(0);
			}
			reject(err);
		});
		server!.listen(SOCK_PATH, () => resolve());
	});

	await writeFile(PID_PATH, `${process.pid}\n`);

	const onSignal = () => {
		void cleanupAndExit(0);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
}
