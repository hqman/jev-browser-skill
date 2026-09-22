import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fetchMock = fileURLToPath(new URL("./offline-jev-fetch.mjs", import.meta.url));
function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(path: string): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ path });
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

function spawnDaemon(
	env: NodeJS.ProcessEnv,
	extraArgs: string[] = [],
): ChildProcess {
	return spawn(
		process.execPath,
		[
			"--import",
			fetchMock,
			"--experimental-strip-types",
			cliPath,
			"--daemon",
			...extraArgs,
		],
		{ env, stdio: ["ignore", "pipe", "pipe"] },
	);
}

async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode) return;
	child.kill("SIGTERM");
	const exited = once(child, "exit");
	const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
	await exited;
	clearTimeout(timer);
}

async function waitForListen(child: ChildProcess, sockPath: string) {
	const stderr: Buffer[] = [];
	child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(
				`daemon exited ${child.exitCode}: ${Buffer.concat(stderr).toString()}`,
			);
		}
		try {
			return await connect(sockPath);
		} catch {
			await delay(40);
		}
	}
	throw new Error(
		`daemon did not listen: ${Buffer.concat(stderr).toString()}`,
	);
}

function rpc(
	socket: net.Socket,
	method: string,
	session = "default",
	params: Record<string, unknown> = {},
): Promise<{ data: unknown; events: Array<{ id?: unknown }> }> {
	const id = `${method}-${session}-${Math.random().toString(16).slice(2)}`;
	const events: Array<{ id?: unknown }> = [];
	return new Promise((resolve, reject) => {
		let buf = "";
		const onData = (chunk: Buffer | string) => {
			buf += chunk.toString();
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				const msg = JSON.parse(line) as {
					id?: unknown;
					type?: unknown;
					ok?: unknown;
					data?: unknown;
					message?: unknown;
				};
				if (msg.type === "event" || msg.type === "log") events.push(msg);
				else if (msg.id === id) {
					socket.off("data", onData);
					if (msg.ok === true) resolve({ data: msg.data, events });
					else reject(new Error(String(msg.message ?? "rpc failed")));
					return;
				}
				nl = buf.indexOf("\n");
			}
		};
		socket.on("data", onData);
		socket.write(`${JSON.stringify({ id, method, session, params })}\n`);
	});
}

test("a second daemon leaves the first socket and pid in place", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jb-daemon-"));
	const sockPath = join(directory, "jb.sock");
	const pidPath = join(directory, "jb.pid");
	const env = { ...process.env, JB_RUNTIME_DIR: directory };
	const first = spawnDaemon(env);
	try {
		const socket = await waitForListen(first, sockPath);
		const before = await stat(sockPath);
		const pid = (await readFile(pidPath, "utf8")).trim();
		assert.equal(pid, String(first.pid));
		const second = spawnDaemon(env);
		const stderr: Buffer[] = [];
		second.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		const [code] = (await once(second, "exit")) as [number | null];
		assert.notEqual(code, 0);
		assert.match(Buffer.concat(stderr).toString(), /already in use/);
		assert.equal((await readFile(pidPath, "utf8")).trim(), pid);
		assert.equal((await stat(sockPath)).ino, before.ino);
		const state = await rpc(socket, "state");
		assert.equal(
			(state.data as { active?: boolean }).active,
			false,
		);
		socket.end();
	} finally {
		await stopProcess(first);
		await rm(directory, { recursive: true, force: true });
	}
});

test("a stale socket is left in place when the daemon is killed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jb-stale-"));
	const sockPath = join(directory, "jb.sock");
	const env = { ...process.env, JB_RUNTIME_DIR: directory };
	const first = spawnDaemon(env);
	try {
		const socket = await waitForListen(first, sockPath);
		socket.destroy();
		const before = await stat(sockPath);
		first.kill("SIGKILL");
		await once(first, "exit");
		assert.equal((await stat(sockPath)).ino, before.ino);
		const second = spawnDaemon(env);
		const [code] = (await once(second, "exit")) as [number | null];
		assert.notEqual(code, 0);
		assert.equal((await stat(sockPath)).ino, before.ino);
	} finally {
		if (first.exitCode === null && !first.signalCode) first.kill("SIGKILL");
		await rm(directory, { recursive: true, force: true });
	}
});

test("the skill launcher works from another directory through a symlink", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jb-skill-"));
	const link = join(directory, "jb-browser");
	await symlink(join(repoRoot, "skills/jev-browser"), link);
	const chunks: Buffer[] = [];
	const child = spawn(join(link, "bin/jb"), ["--help"], {
		cwd: directory,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
	const [code] = (await once(child, "exit")) as [number | null];
	assert.equal(code, 0);
	assert.match(Buffer.concat(chunks).toString(), /jb shutdown/);
	await rm(directory, { recursive: true, force: true });
});

test(
	"stop closes one session, events stay on their request, shutdown exits",
	{ timeout: 120_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "jb-sessions-"));
		const outputDir = join(directory, "out");
		const configPath = join(directory, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				outputDir,
				recordVideo: false,
				headless: true,
				allowedOrigins: ["http://*", "https://*"],
			}),
		);
		const server = createServer((_req, res) => res.end("<h1>Ready</h1>"));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("No test server address");
		}
		const url = `http://127.0.0.1:${address.port}`;
		const env = {
			...process.env,
			JB_RUNTIME_DIR: directory,
			JB_CONFIG: configPath,
			JB_PROVIDER: "typesafe",
			TYPESAFE_API_KEY: "offline-test",
		};
		const daemon = spawnDaemon(env);
		const alpha = { socket: undefined as net.Socket | undefined };
		const beta = { socket: undefined as net.Socket | undefined };
		try {
			const sockPath = join(directory, "jb.sock");
			alpha.socket = await waitForListen(daemon, sockPath);
			beta.socket = await connect(sockPath);
			const params = {
				goal: "Observe the Ready heading",
				url,
				headless: true,
				recordVideo: false,
			};
			const [first, second] = await Promise.all([
				rpc(alpha.socket, "run", "alpha", params),
				rpc(beta.socket, "run", "beta", params),
			]);
			assert.equal((first.data as { status?: string }).status, "done_unverified");
			assert.equal((second.data as { status?: string }).status, "done_unverified");
			assert.ok(first.events.length > 0);
			assert.ok(second.events.length > 0);
			assert.ok(first.events.every((event) => String(event.id).startsWith("run-alpha-")));
			assert.ok(second.events.every((event) => String(event.id).startsWith("run-beta-")));
			await rpc(alpha.socket, "stop", "alpha");
			const alphaState = await rpc(alpha.socket, "state", "alpha");
			const betaState = await rpc(beta.socket, "state", "beta");
			assert.equal((alphaState.data as { active?: boolean }).active, false);
			assert.equal((betaState.data as { active?: boolean }).active, true);
			await rpc(beta.socket, "shutdown", "beta");
			const [code] = (await once(daemon, "exit")) as [number | null];
			assert.equal(code, 0);
			await assert.rejects(connect(sockPath));
		} finally {
			alpha.socket?.destroy();
			beta.socket?.destroy();
			await stopProcess(daemon);
			await new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			);
			await rm(directory, { recursive: true, force: true });
		}
	},
);
