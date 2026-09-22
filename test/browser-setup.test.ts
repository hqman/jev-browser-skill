import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserSetup } from "../src/browser-setup.ts";

test("browser setup shares installation and caches success", async () => {
	let calls = 0;
	let finish!: () => void;
	const ensure = createBrowserSetup(async () => {
		calls++;
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
	});
	const first = ensure();
	assert.equal(ensure(), first);
	await Promise.resolve();
	assert.equal(calls, 1);
	finish();
	await first;
	await ensure();
	assert.equal(calls, 1);
});

test("failed browser setup reports failure and allows a later retry", async () => {
	let calls = 0;
	const ensure = createBrowserSetup(async () => {
		if (++calls === 1) throw new Error("offline");
	});
	await assert.rejects(ensure(), /offline/);
	await ensure();
	assert.equal(calls, 2);
});
