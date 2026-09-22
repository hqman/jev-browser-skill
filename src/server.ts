import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, lstat, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { daemonConfigFingerprint } from "./daemon-identity.ts";
import { JB_DIR, LOCK_PATH, PID_PATH, SOCK_PATH } from "./ipc.ts";
import { JevBrowserManager } from "./runtime.ts";
import type { BrowserAction } from "./types.ts";

type JsonObject = Record<string, unknown>;

interface RpcRequest {
	id?: unknown;
	method?: unknown;
	session?: unknown;
	params?: unknown;
	daemonFingerprint?: unknown;
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
let cleanupStarted = false;
let ownsRuntimeLock = false;
let ownsRuntimeFiles = false;
const ownFingerprint = daemonConfigFingerprint();
const requests = new AsyncLocalStorage<{ socket: net.Socket; id: string; active: boolean }>();
const pending = new Set<Promise<unknown>>();

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
			const client = requests.getStore();
			if (!client?.active || name !== "jev_browser_update") return;
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
	if (cleanupStarted) return;
	cleanupStarted = true;
	exiting = true;
	for (const sessionId of [...knownSessions]) {
		await manager.stop({ sessionId }).catch(() => undefined);
	}
	// A browser may still have been starting when stop was first requested.
	await Promise.allSettled([...pending]);
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
	// The exclusive lifecycle lock remains held while listen is released and
	// the published names are removed. Once the lock is released this process
	// never touches runtime paths again, so a replacement daemon cannot lose
	// its socket or pid file to an older process finishing cleanup.
	await removeOwnRuntimeFiles().catch(() => undefined);
	process.exit(code);
}

async function removeOwnRuntimeFiles(): Promise<void> {
	if (!ownsRuntimeLock) return;
	if (ownsRuntimeFiles) {
		await unlinkIfPresent(SOCK_PATH);
		await unlinkIfPresent(PID_PATH);
		ownsRuntimeFiles = false;
	}
	await rmdir(LOCK_PATH);
	ownsRuntimeLock = false;
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
			return manager.stop(context);
		case "shutdown":
			return { shuttingDown: true };
		default:
			throw new Error(`unknown method: ${method}`);
	}
}

async function handleRequest(socket: net.Socket, line: string): Promise<void> {
	let req: RpcRequest;
	try {
		req = JSON.parse(line) as RpcRequest;
		if (!req || typeof req !== "object" || Array.isArray(req)) {
			throw new Error("request must be an object");
		}
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
	const fingerprint =
		typeof req.daemonFingerprint === "string" ? req.daemonFingerprint : "";

	const client = { socket, id, active: true };
	try {
		if (exiting) throw new Error("Daemon is shutting down.");
		if (!method) throw new Error("missing method");
		if (
			method !== "stop" &&
			method !== "shutdown" &&
			fingerprint !== ownFingerprint
		) {
			throw new Error(
				"This jb daemon was started with different provider, credential, or config settings. Run `jb shutdown`, then retry so a daemon starts with the current settings.",
			);
		}
		if (method === "shutdown") exiting = true;
		const work = requests.run(client, () => dispatch(method, params, sessionId));
		pending.add(work);
		let data: unknown;
		try {
			data = await work;
		} finally {
			pending.delete(work);
		}
		await writeJsonFlushed(socket, { id, type: "result", ok: true, data });
		if (method === "shutdown") {
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
		client.active = false;
	}
}

function attachSocket(socket: net.Socket): void {
	socket.setEncoding("utf8");
	let buf = "";
	let queue = Promise.resolve();
	socket.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		if (Buffer.byteLength(buf) > 1024 * 1024) {
			socket.destroy();
			return;
		}
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
	process.umask(0o077);
	await mkdir(JB_DIR, { recursive: true, mode: 0o700 });
	const directory = await lstat(JB_DIR);
	if (!directory.isDirectory() || directory.isSymbolicLink() ||
		(process.getuid && directory.uid !== process.getuid())) {
		throw new Error("Runtime directory must be an owned directory, not a symlink.");
	}
	await chmod(JB_DIR, 0o700);
	try {
		await mkdir(LOCK_PATH, { mode: 0o700 });
		ownsRuntimeLock = true;
	} catch (err) {
		if (errCode(err) === "EEXIST") {
			throw new Error(
				`Daemon lifecycle lock is already held at ${LOCK_PATH}. Another jb daemon may be starting, running, or shutting down. This process will not remove runtime files. If no jb process is alive, remove ${LOCK_PATH}, ${SOCK_PATH}, and ${PID_PATH} yourself.`,
			);
		}
		throw err;
	}
	installHostBridge();

	server = net.createServer(attachSocket);

	// Bind the existing path. Do not unlink it first: a second process would
	// steal the name and leave the first daemon running with no clients.
	try {
		await new Promise<void>((resolve, reject) => {
			server!.once("error", (err) => {
				if (errCode(err) === "EADDRINUSE") {
					reject(
						new Error(
							`Daemon socket is already in use at ${SOCK_PATH}. Another jb daemon may still be running (see ${PID_PATH}). This process will not remove the socket or the pid file. If that process is not alive, remove ${LOCK_PATH}, ${SOCK_PATH}, and ${PID_PATH} yourself and start again.`,
						),
					);
					return;
				}
				reject(err);
			});
			server!.listen(SOCK_PATH, () => resolve());
		});
		ownsRuntimeFiles = true;
		await chmod(SOCK_PATH, 0o600);
		await writeFile(PID_PATH, `${process.pid}\n`, { mode: 0o600 });
	} catch (error) {
		if (ownsRuntimeLock) {
			await new Promise<void>((resolve) => {
				if (!server?.listening) return resolve();
				server.close(() => resolve());
			});
			await removeOwnRuntimeFiles().catch(() => undefined);
		}
		throw error;
	}

	const onSignal = () => {
		void cleanupAndExit(0);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
}
