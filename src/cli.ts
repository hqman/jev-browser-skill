import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SOCK_PATH = join(homedir(), ".jb", "jb.sock");

const USAGE = `Usage:
  jb [--session ID] run --goal "…" [--url URL] [--max-steps N] [--headless] [--headed]
  jb [--session ID] reply --text "…" [--max-steps N]
  jb [--session ID] actions --json '{...}'
  jb [--session ID] state
  jb [--session ID] logs [--tail N]
  jb [--session ID] stream [--action start|status|stop] [--interval-ms N]
  jb [--session ID] stop`;

interface Flags {
	session: string;
	command?: string;
	goal?: string;
	url?: string;
	text?: string;
	maxSteps?: number;
	headless?: boolean;
	json?: string;
	tail?: number;
	action?: string;
	intervalMs?: number;
}

interface RpcMessage {
	id?: unknown;
	type?: unknown;
	event?: unknown;
	payload?: unknown;
	line?: unknown;
	ok?: unknown;
	data?: unknown;
	message?: unknown;
}

function errCode(err: unknown): string | undefined {
	if (err && typeof err === "object" && "code" in err) {
		return String((err as { code: unknown }).code);
	}
	return undefined;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function printUsage(): void {
	console.error(USAGE);
}

function fail(message: string, showUsage = false): never {
	console.error(message);
	if (showUsage) printUsage();
	process.exit(1);
}

function takeValue(argv: string[], i: number, flag: string): [string, number] {
	const value = argv[i + 1];
	if (value === undefined || value.startsWith("--")) {
		fail(`missing value for ${flag}`, true);
	}
	return [value, i + 1];
}

function parseNumberFlag(flag: string, raw: string): number {
	const n = Number(raw);
	if (!Number.isFinite(n)) fail(`invalid ${flag}: ${raw}`);
	return n;
}

function parseArgv(argv: string[]): Flags {
	const flags: Flags = { session: "default" };
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		switch (arg) {
			case "--session": {
				const [value, next] = takeValue(argv, i, arg);
				flags.session = value;
				i = next;
				break;
			}
			case "--goal": {
				const [value, next] = takeValue(argv, i, arg);
				flags.goal = value;
				i = next;
				break;
			}
			case "--url": {
				const [value, next] = takeValue(argv, i, arg);
				flags.url = value;
				i = next;
				break;
			}
			case "--text": {
				const [value, next] = takeValue(argv, i, arg);
				flags.text = value;
				i = next;
				break;
			}
			case "--max-steps": {
				const [value, next] = takeValue(argv, i, arg);
				flags.maxSteps = parseNumberFlag(arg, value);
				i = next;
				break;
			}
			case "--headless":
				flags.headless = true;
				break;
			case "--headed":
				flags.headless = false;
				break;
			case "--json": {
				const [value, next] = takeValue(argv, i, arg);
				flags.json = value;
				i = next;
				break;
			}
			case "--tail": {
				const [value, next] = takeValue(argv, i, arg);
				flags.tail = parseNumberFlag(arg, value);
				i = next;
				break;
			}
			case "--action": {
				const [value, next] = takeValue(argv, i, arg);
				flags.action = value;
				i = next;
				break;
			}
			case "--interval-ms": {
				const [value, next] = takeValue(argv, i, arg);
				flags.intervalMs = parseNumberFlag(arg, value);
				i = next;
				break;
			}
			default:
				if (arg.startsWith("--")) fail(`unknown flag: ${arg}`, true);
				positionals.push(arg);
		}
	}
	if (positionals.length > 1) {
		fail(`unexpected argument: ${positionals[1]}`, true);
	}
	flags.command = positionals[0];
	return flags;
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

function connectOnce(): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ path: SOCK_PATH });
		const onError = (err: Error) => {
			socket.destroy();
			reject(err);
		};
		socket.once("connect", () => {
			socket.off("error", onError);
			resolve(socket);
		});
		socket.once("error", onError);
	});
}

function spawnDaemon(): void {
	const entry = fileURLToPath(import.meta.url);
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", entry, "--daemon"],
		{
			detached: true,
			stdio: "ignore",
			env: process.env,
		},
	);
	child.unref();
}

async function unlinkSock(): Promise<void> {
	try {
		await unlink(SOCK_PATH);
	} catch (err) {
		if (errCode(err) !== "ENOENT") throw err;
	}
}

async function waitForSockGone(timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const socket = await connectOnce();
			socket.destroy();
		} catch (err) {
			const code = errCode(err);
			if (code === "ENOENT" || code === "ECONNREFUSED") {
				await unlinkSock().catch(() => undefined);
				return;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function connectAliveDaemon(): Promise<net.Socket | undefined> {
	try {
		return await connectOnce();
	} catch (err) {
		const code = errCode(err);
		if (code !== "ENOENT" && code !== "ECONNREFUSED") throw err;
		await unlinkSock().catch(() => undefined);
		return undefined;
	}
}

async function ensureDaemon(
	startIfMissing: boolean,
): Promise<net.Socket | undefined> {
	const existing = await connectAliveDaemon();
	if (existing) return existing;
	if (!startIfMissing) return undefined;

	spawnDaemon();

	const deadline = Date.now() + 8000;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 80));
		try {
			return await connectOnce();
		} catch (err) {
			lastErr = err;
		}
	}
	fail(
		`jb: failed to connect to daemon at ${SOCK_PATH}${
			lastErr ? `: ${errMessage(lastErr)}` : ""
		}`,
	);
}

function printRunSummary(data: unknown): void {
	const d =
		data && typeof data === "object" ? (data as Record<string, unknown>) : {};
	const steps = d.steps;
	const stepCount = Array.isArray(steps) ? steps.length : steps;
	const finalScreenshot =
		d.finalScreenshot && typeof d.finalScreenshot === "object"
			? (d.finalScreenshot as { artifactPath?: unknown })
			: undefined;
	console.log(
		JSON.stringify(
			{
				status: d.status,
				steps: stepCount,
				artifactPath: finalScreenshot?.artifactPath,
				reason: d.message,
				textRequest: d.textRequest,
				elapsedMs: d.elapsedMs,
				tracePath: d.tracePath,
			},
			null,
			2,
		),
	);
}

async function rpc(
	method: string,
	session: string,
	params: Record<string, unknown>,
	startIfMissing = true,
): Promise<unknown> {
	const socket = await ensureDaemon(startIfMissing);
	if (!socket) return undefined;
	const printed = new Set<string>();
	return new Promise((resolve, reject) => {
		let buf = "";
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			socket.end();
			fn();
		};

		socket.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line) handleLine(line);
				nl = buf.indexOf("\n");
			}
		});
		socket.on("error", (err) => {
			finish(() => reject(err));
		});
		socket.on("end", () => {
			if (!settled) {
				finish(() =>
					reject(
						new Error("daemon closed the connection before sending a result"),
					),
				);
			}
		});

		function handleLine(line: string): void {
			let msg: RpcMessage;
			try {
				msg = JSON.parse(line) as RpcMessage;
			} catch (err) {
				fail(`invalid daemon response: ${errMessage(err)}`);
			}
			if (msg.type === "log" && typeof msg.line === "string") {
				if (!printed.has(msg.line)) {
					console.log(msg.line);
					printed.add(msg.line);
				}
				return;
			}
			if (msg.type === "event" && msg.event === "jev-step") {
				const formatted = formatJevStep(msg.payload);
				if (formatted && !printed.has(formatted)) {
					console.log(formatted);
					printed.add(formatted);
				}
				return;
			}
			if (msg.type === "result") {
				finish(() => resolve(msg.data));
				return;
			}
			if (msg.type === "error") {
				const message =
					typeof msg.message === "string" ? msg.message : "daemon error";
				finish(() => fail(message));
			}
		}

		socket.write(
			`${JSON.stringify({ id: "1", method, session, params })}\n`,
		);
	});
}

function buildParams(flags: Flags): {
	method: string;
	params: Record<string, unknown>;
} {
	const command = flags.command;
	if (!command) fail("missing command", true);

	switch (command) {
		case "run": {
			if (!flags.goal) fail("jb run requires --goal", true);
			const params: Record<string, unknown> = { goal: flags.goal };
			if (flags.url !== undefined) params.url = flags.url;
			if (flags.maxSteps !== undefined) params.maxSteps = flags.maxSteps;
			if (flags.headless !== undefined) params.headless = flags.headless;
			return { method: "run", params };
		}
		case "reply": {
			if (flags.text === undefined) fail("jb reply requires --text", true);
			const params: Record<string, unknown> = { text: flags.text };
			if (flags.maxSteps !== undefined) params.maxSteps = flags.maxSteps;
			return { method: "reply", params };
		}
		case "actions": {
			if (!flags.json) fail("jb actions requires --json", true);
			let parsed: unknown;
			try {
				parsed = JSON.parse(flags.json);
			} catch (err) {
				fail(`invalid --json: ${errMessage(err)}`);
			}
			const params = Array.isArray(parsed)
				? { actions: parsed }
				: parsed && typeof parsed === "object"
					? (parsed as Record<string, unknown>)
					: fail("jb actions --json must be an object or array");
			return { method: "actions", params };
		}
		case "state":
			return { method: "state", params: {} };
		case "logs": {
			const params: Record<string, unknown> = {};
			if (flags.tail !== undefined) params.limit = flags.tail;
			return { method: "logs", params };
		}
		case "stream": {
			const action = flags.action ?? "status";
			if (action !== "start" && action !== "status" && action !== "stop") {
				fail('stream --action must be "start", "status", or "stop"', true);
			}
			const params: Record<string, unknown> = { action };
			if (flags.intervalMs !== undefined) params.intervalMs = flags.intervalMs;
			return { method: "stream", params };
		}
		case "stop":
			return { method: "stop", params: {} };
		default:
			fail(`unknown command: ${command}`, true);
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("--daemon")) {
		const { startDaemon } = await import("./server.ts");
		await startDaemon();
		return;
	}

	const flags = parseArgv(argv);
	const { method, params } = buildParams(flags);
	if (method === "run" || method === "reply") {
		const { readJevCredentials } = await import("./credentials.ts");
		try {
			readJevCredentials();
		} catch (err) {
			fail(errMessage(err));
		}
	}
	const startIfMissing = method === "run" || method === "actions";
	const data = await rpc(method, flags.session, params, startIfMissing);
	if (data === undefined) {
		if (method === "reply") {
			fail(
				"No browser is open. Leave the session running after needs_text, then reply.",
			);
		}
		if (method === "stop") {
			console.log(
				JSON.stringify({
					active: false,
					message: "No browser is active for this session.",
				}),
			);
			return;
		}
		fail("No jb daemon is running. Start one with `jb run`.");
	}
	if (method === "run" || method === "reply") printRunSummary(data);
	else console.log(JSON.stringify(data, null, 2));
	if (method === "stop") await waitForSockGone();
}

main().catch((err) => {
	console.error(errMessage(err));
	process.exit(1);
});
