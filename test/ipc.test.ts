import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("JSON IPC context supports wait batches and plugin-local cancellation", async () => {
	const directory = mkdtempSync(join(tmpdir(), "browser-ipc-"));
	const config = join(directory, "config.json");
	writeFileSync(
		config,
		JSON.stringify({ outputDir: directory, recordVideo: false }),
	);
	process.env.JB_CONFIG = config;
	const { JevBrowserManager } = await import("../src/runtime.ts");
	const manager = new JevBrowserManager();
	const server = createServer((_req, res) => res.end("<h1>Ready</h1>"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No test server address");
	const url = `http://127.0.0.1:${address.port}`;
	const context = JSON.parse(
		JSON.stringify({
			sessionId: "ipc-test",
			signal: new AbortController().signal,
		}),
	);
	assert.deepEqual(context.signal, {});
	try {
		const originalFetch = globalThis.fetch;
		const originalKey = process.env.AI_GATEWAY_API_KEY;
		process.env.AI_GATEWAY_API_KEY = "offline-test";
		globalThis.fetch = async (_url, init) => {
			const { questions } = JSON.parse(String(init?.body));
			return Response.json({
				answers: Object.fromEntries(
					Object.entries(questions).map(([id, q]) => {
						const keys = Object.keys((q as { criteria: object }).criteria);
						const choice = id === "action" ? "DONE" : keys[0];
						return [
							id,
							{
								type: "choice",
								choice,
								probabilities: Object.fromEntries(
									keys.map((k) => [k, k === choice ? 1 : 0]),
								),
							},
						];
					}),
				),
			});
		};
		try {
			const run = await manager.run(
				{ goal: "Observe the Ready heading", url },
				context,
			);
			assert.equal(run.status, "done_unverified");
			assert.ok(existsSync(run.initialScreenshot.artifactPath));
			assert.ok(
				run.finalScreenshot && existsSync(run.finalScreenshot.artifactPath),
			);
			const second = await manager.run(
				{ goal: "Observe the Ready heading" },
				context,
			);
			assert.equal(
				second.initialScreenshot.state.startedAt,
				run.initialScreenshot.state.startedAt,
			);
			assert.notEqual(
				second.finalScreenshot?.artifactPath,
				run.finalScreenshot?.artifactPath,
			);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
			else process.env.AI_GATEWAY_API_KEY = originalKey;
		}
		const waiting = manager.actions(
			{ actions: [{ type: "wait", ms: 30000 }], includeScreenshot: false },
			context,
		);
		const cancelled = assert.rejects(waiting, /abort/i);
		await assert.rejects(
			manager.actions({ actions: [{ type: "wait", ms: 1 }] }, context),
			/active/,
		);
		await manager.stop(context);
		await cancelled;
	} finally {
		await manager.stop(context);
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		rmSync(directory, { recursive: true, force: true });
	}
});
