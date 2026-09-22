import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { observe } from "../src/jev-browser.ts";
import { runJev } from "../src/jev-run.ts";

test("post-action navigation read is recovered without repeating the click", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.setContent(
			"<button onclick=\"this.textContent='Opened'\">Open</button>",
		);
		const originalRead = page.evaluateHandle.bind(page);
		let invalidateNextRead = false;
		let failures = 0;
		page.evaluateHandle = (async (
			...args: Parameters<typeof page.evaluateHandle>
		) => {
			if (invalidateNextRead) {
				invalidateNextRead = false;
				failures++;
				throw new Error(
					"Execution context was destroyed, most likely because of a navigation",
				);
			}
			return originalRead(...args);
		}) as typeof page.evaluateHandle;
		let clicks = 0;
		const result = await runJev(
			{ goal: "Open" },
			{
				page: () => page,
				onStep: async (step) => {
					if (step.status === "executed") {
						clicks++;
						invalidateNextRead = true;
					}
				},
				policy: {
					async choose(data, _goal, history) {
						if (clicks) {
							assert.equal(data.targets[0]?.label, "Opened");
							assert.equal(history.length, 1);
							return { operation: "DONE" };
						}
						return { operation: "CLICK", target: data.targets[0] };
					},
				},
			},
		);
		assert.equal(result.status, "done_unverified");
		assert.equal(clicks, 1);
		assert.equal(failures, 1);
		assert.equal(result.steps.length, 1);

		page.evaluateHandle = originalRead;
		await page.evaluate(() => {
			document.body.remove();
			setTimeout(() => {
				const body = document.createElement("body");
				body.innerHTML = "<h1>New document ready</h1>";
				document.documentElement.append(body);
			}, 150);
		});
		const settled = await observe(page);
		assert.match(settled.data.text, /New document ready/);
		await settled.dispose();

		let readyWaits = 0;
		const originalWaitForFunction = page.waitForFunction.bind(page);
		page.waitForFunction = (async (
			...args: Parameters<typeof page.waitForFunction>
		) => {
			readyWaits++;
			if (readyWaits === 1) {
				const error = new Error("Timeout 5000ms exceeded.");
				error.name = "TimeoutError";
				throw error;
			}
			return originalWaitForFunction(...args);
		}) as typeof page.waitForFunction;
		const recovered = await observe(page);
		assert.match(recovered.data.text, /New document ready/);
		assert.equal(readyWaits, 2);
		await recovered.dispose();
		page.waitForFunction = originalWaitForFunction;

		let reads = 0;
		page.evaluateHandle = async () => {
			reads++;
			throw new Error("Execution context was destroyed");
		};
		await assert.rejects(observe(page), /Execution context/);
		assert.equal(reads, 5);
		reads = 0;
		page.evaluateHandle = async () => {
			reads++;
			throw new Error("Unexpected page bug");
		};
		await assert.rejects(observe(page), /Unexpected page bug/);
		assert.equal(reads, 1);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(observe(page, controller.signal), /abort/i);
		assert.equal(reads, 1);
	} finally {
		await browser.close();
	}
});
