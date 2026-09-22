import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { chromium } from "playwright";
import { type Observation, observe } from "../src/jev-browser.ts";
import {
	buildQuestions,
	createJevPolicy,
	type JevPolicy,
	TYPESAFE_SYSTEMONE_URL,
} from "../src/jev-model.ts";
import { isRevisitedHref, type RunStep, runJev } from "../src/jev-run.ts";

const observation: Observation = {
	url: "https://example.test",
	title: "Search",
	text: "Search",
	scrollUp: false,
	scrollDown: true,
	targets: [
		{ id: "1", operation: "TYPE_TEXT", label: "Query", value: "" },
		{ id: "2", operation: "CLICK", label: "Search", value: "" },
	],
};

test("revisited listing URLs are hidden so pagination cannot reset", () => {
	const visited = ["https://example.test/blog"];
	assert.equal(
		isRevisitedHref(
			"https://example.test/blog/",
			"https://example.test/blog/2/",
			visited,
		),
		true,
	);
	assert.equal(
		isRevisitedHref(
			"https://example.test/blog/3/",
			"https://example.test/blog/2/",
			visited,
		),
		false,
	);
	assert.equal(
		isRevisitedHref(
			"https://example.test/blog/#notes",
			"https://example.test/blog/",
			visited,
		),
		false,
	);
});

test("one question compares concrete actions against scrolling and terminal choices", () => {
	const q = buildQuestions(observation, "Find cats");
	assert.equal(q.action.type, "choice");
	assert.deepEqual(Object.keys(q.action.criteria), [
		"WAIT",
		"BLOCKED",
		"REVIEW",
		"DONE",
		"TYPE_TEXT:1",
		"CLICK:2",
		"SCROLL_DOWN",
	]);
	const checked = buildQuestions(
		{
			...observation,
			targets: [
				{
					id: "3",
					operation: "CLICK",
					label: "Small",
					value: "small",
					role: "radio",
					checked: "true",
				},
			],
		},
		"Choose small",
	);
	assert.ok(!Object.hasOwn(checked.action.criteria, "CLICK:3"));
	assert.ok(
		!Object.hasOwn(
			buildQuestions({ ...observation, text: "" }, "Finish").action.criteria,
			"DONE",
		),
	);
});

describe("Jev providers (offline fetch mocks)", { concurrency: false }, () => {
test("real AI SDK Gateway adapter evaluates concrete actions in one request", async () => {
	const originalFetch = globalThis.fetch;
	const originalKey = process.env.AI_GATEWAY_API_KEY;
	const originalProvider = process.env.JB_PROVIDER;
	process.env.AI_GATEWAY_API_KEY = "offline-test-key";
	process.env.JB_PROVIDER = "gateway";
	let calls = 0;
	globalThis.fetch = async (url, init) => {
		calls++;
		assert.match(String(url), /\/evaluation-model$/);
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("authorization"), "Bearer offline-test-key");
		assert.equal(headers.get("ai-model-id"), "typesafe-ai/jev");
		const request = JSON.parse(String(init?.body));
		assert.deepEqual(Object.keys(request.questions), ["action"]);
		const choices = Object.keys(request.questions.action.criteria);
		return Response.json({
			answers: {
				action: {
					type: "choice",
					choice: "CLICK:2",
					probabilities: Object.fromEntries(
						choices.map((c) => [c, c === "CLICK:2" ? 1 : 0]),
					),
				},
			},
		});
	};
	try {
		const result = await createJevPolicy().choose(
			observation,
			"Search",
			[],
			new AbortController().signal,
		);
		assert.equal(calls, 1);
		assert.equal(result.operation, "CLICK");
		assert.equal(result.target?.id, "2");
		assert.equal(result.probability, 1);
	} finally {
		globalThis.fetch = originalFetch;
		if (originalKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
		else process.env.AI_GATEWAY_API_KEY = originalKey;
		if (originalProvider === undefined) delete process.env.JB_PROVIDER;
		else process.env.JB_PROVIDER = originalProvider;
	}
});

test("TypeSafe System One adapter evaluates concrete actions in one request", async () => {
	const originalFetch = globalThis.fetch;
	const previous = {
		JB_PROVIDER: process.env.JB_PROVIDER,
		TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
		TYPESAFE_MODEL: process.env.TYPESAFE_MODEL,
	};
	process.env.JB_PROVIDER = "typesafe";
	process.env.TYPESAFE_API_KEY = "offline-typesafe-key";
	process.env.TYPESAFE_MODEL = "jev-latest";
	let calls = 0;
	globalThis.fetch = async (url, init) => {
		calls++;
		assert.equal(String(url), TYPESAFE_SYSTEMONE_URL);
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("authorization"), "Bearer offline-typesafe-key");
		assert.equal(headers.get("content-type"), "application/json");
		const request = JSON.parse(String(init?.body));
		assert.equal(typeof request.state, "object");
		assert.ok(request.state.page);
		assert.deepEqual(request.state.recentActions, []);
		assert.equal(request.model, "jev-latest");
		assert.deepEqual(Object.keys(request.questions), ["action"]);
		const choices = Object.keys(request.questions.action.criteria);
		assert.ok(choices.includes("CLICK:2"));
		return Response.json({
			answers: {
				action: {
					type: "choice",
					choice: "CLICK:2",
					probabilities: Object.fromEntries(
						choices.map((c) => [c, c === "CLICK:2" ? 0.9 : 0]),
					),
					confidence: 0.7,
				},
			},
		});
	};
	try {
		const result = await createJevPolicy().choose(
			observation,
			"Search",
			[],
			new AbortController().signal,
		);
		assert.equal(calls, 1);
		assert.equal(result.operation, "CLICK");
		assert.equal(result.target?.id, "2");
		assert.equal(result.probability, 0.9);
		assert.equal(result.providerConfidence, 0.7);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("TypeSafe System One HTTP 401 includes status and server message", async () => {
	const originalFetch = globalThis.fetch;
	const previous = {
		JB_PROVIDER: process.env.JB_PROVIDER,
		TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
		TYPESAFE_MODEL: process.env.TYPESAFE_MODEL,
	};
	process.env.JB_PROVIDER = "typesafe";
	process.env.TYPESAFE_API_KEY = "offline-typesafe-key";
	process.env.TYPESAFE_MODEL = "jev-latest";
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ message: "Invalid API key" }), {
			status: 401,
			statusText: "Unauthorized",
		});
	try {
		await assert.rejects(
			() =>
				createJevPolicy().choose(
					observation,
					"Search",
					[],
					new AbortController().signal,
				),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /401/);
				assert.match(error.message, /Invalid API key/);
				assert.doesNotMatch(error.message, /offline-typesafe-key/);
				return true;
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
});

test("browser loop and stale-target guards (offline)", async (t) => {
	const browser = await chromium.launch({
		headless: true,
		...(process.env.JEV_TEST_BROWSER
			? { executablePath: process.env.JEV_TEST_BROWSER }
			: {}),
	});
	try {
		const page = await browser.newPage();
		const fixture = async () =>
			page.setContent(
				`<label>Query <input id="query"></label><button onclick="document.querySelector('#result').textContent = document.querySelector('#query').value">Search</button><p id="result"></p><input type="password" value="secret"><input disabled value="disabled">`,
			);
		await t.test(
			"fills and clicks, records actions, returns DONE as unverified",
			async () => {
				await fixture();
				let calls = 0;
				const recorded: RunStep[] = [];
				const memory = { goal: "Search for cats", actions: [] };
				const policy: JevPolicy = {
					async choose(data) {
						assert.equal(
							data.targets.some(
								(e) => e.value === "secret" || e.value === "disabled",
							),
							false,
						);
						calls++;
						const operation =
							calls === 1 ? "TYPE_TEXT" : calls === 2 ? "CLICK" : "DONE";
						return {
							operation,
							probability: 0.99,
							target: data.targets.find(
								(e) =>
									e.operation === operation &&
									(operation !== "CLICK" || e.label === "Search"),
							),
						};
					},
				};
				const paused = await runJev(
					{ goal: "Search for cats" },
					{
						page: () => page,
						policy,
						memory,
						onStep: async (step) => {
							recorded.push(step);
						},
					},
				);
				assert.equal(paused.status, "needs_text");
				assert.equal(paused.textRequest?.label, "Query");
				assert.equal(await page.locator("#query").inputValue(), "");
				const result = await runJev(
					{ goal: "Search for cats" },
					{
						page: () => page,
						policy,
						memory,
						textReply: "cats",
						onStep: async (step) => {
							recorded.push(step);
						},
					},
				);
				assert.equal(result.status, "done_unverified");
				assert.equal(await page.locator("#result").textContent(), "cats");
				assert.equal(memory.pendingText, undefined);
				assert.deepEqual(
					recorded.map((s) => s.status),
					["decision", "decision", "attempted", "executed", "decision"],
				);
			},
		);
		await t.test(
			"stale text decision re-evaluates without executing the stale mutation",
			async () => {
				await fixture();
				let calls = 0;
				const result = await runJev(
					{ goal: "Search" },
					{
						page: () => page,
						policy: {
							async choose(data) {
								calls++;
								if (calls === 2) return { operation: "BLOCKED" };
								await page.locator("#query").fill("changed by user");
								return {
									operation: "TYPE_TEXT",
									target: data.targets.find((e) => e.operation === "TYPE_TEXT"),
									probability: 1,
								};
							},
						},
					},
				);
				assert.equal(result.status, "blocked");
				assert.equal(calls, 2);
				assert.equal(
					await page.locator("#query").inputValue(),
					"changed by user",
				);
			},
		);
		await t.test(
			"skips video players and media file links, keeps X post links",
			async () => {
				await page.setContent(
					`<a href="https://example.com/note">Article</a>
					 <a href="https://example.com/demo.mp4">Download video</a>
					 <button aria-label="Play"></button>
					 <div><video controls src="https://example.com/clip.mp4"></video></div>
					 <a href="https://x.com/kai/status/1">View the original post on X</a>`,
				);
				const snapshot = await observe(page);
				try {
					const labels = snapshot.data.targets.map((t) => t.label);
					const hrefs = snapshot.data.targets.map((t) => t.href || "");
					assert.ok(labels.includes("Article"));
					assert.ok(
						snapshot.data.targets.some((t) =>
							/View the original post on X/.test(t.label),
						),
					);
					assert.equal(
						snapshot.data.targets.some((t) => t.label === "Play"),
						false,
					);
					assert.equal(
						snapshot.data.targets.some((t) => t.label === "Download video"),
						false,
					);
					assert.equal(
						hrefs.some((href) => /\.mp4(\?|#|$)/i.test(href)),
						false,
					);
				} finally {
					await snapshot.dispose();
				}
			},
		);
		await t.test(
			"skips current-section nav that would reset pagination, keeps Next",
			async () => {
				await page.route("https://example.test/**", async (route) => {
					const path = new URL(route.request().url()).pathname.replace(
						/\/+$/,
						"",
					);
					const writingCurrent =
						path === "/blog" ? ' aria-current="page"' : "";
					const html = `<!doctype html><nav>
						<a href="https://example.test/">Home</a>
						<a href="https://example.test/blog/"${writingCurrent}>Writing</a>
						<a href="https://example.test/demos/">Demos</a>
					</nav>
					<a href="https://example.test/blog/ox-alpha/">Ox Alpha Rebuilt My 3D Globe Dashboard on OpenRouter</a>
					<nav>
						<a href="https://example.test/blog/3/" aria-label="Page 3">3</a>
						<a href="https://example.test/blog/3/">Next</a>
					</nav>`;
					await route.fulfill({
						contentType: "text/html",
						body: html,
					});
				});
				try {
					await page.goto("https://example.test/blog/2/");
					const listing = await observe(page);
					try {
						const labels = listing.data.targets.map((t) => t.label);
						assert.equal(labels.includes("Writing"), false);
						assert.ok(labels.includes("Next"));
						assert.ok(labels.includes("Demos"));
						assert.ok(
							labels.some((label) => /Ox Alpha/.test(label)),
						);
					} finally {
						await listing.dispose();
					}
					await page.goto("https://example.test/");
					const home = await observe(page);
					try {
						assert.ok(
							home.data.targets.some((t) => t.label === "Writing"),
						);
					} finally {
						await home.dispose();
					}
				} finally {
					await page.unroute("https://example.test/**");
				}
			},
		);
		await t.test(
			"after Next, choose does not see Writing and can open the article",
			async () => {
				await page.route("https://example.test/**", async (route) => {
					const path =
						new URL(route.request().url()).pathname.replace(/\/+$/, "") ||
						"/";
					const article =
						path === "/blog/2"
							? `<a href="https://example.test/blog/ox-alpha/">Ox Alpha Rebuilt My 3D Globe Dashboard on OpenRouter</a>`
							: `<a href="https://example.test/blog/other/">Other post</a>`;
					const next =
						path === "/blog"
							? `<a href="https://example.test/blog/2/">Next</a>`
							: `<a href="https://example.test/blog/3/">Next</a>`;
					await route.fulfill({
						contentType: "text/html",
						body: `<!doctype html><nav><a href="https://example.test/blog/">Writing</a></nav>${article}${next}`,
					});
				});
				try {
					await page.goto("https://example.test/blog/");
					let sawWritingAfterNext = false;
					const result = await runJev(
						{ goal: "Open the Ox Alpha article", maxSteps: 5 },
						{
							page: () => page,
							policy: {
								async choose(data) {
									if (data.url.includes("/blog/2")) {
										if (data.targets.some((t) => t.label === "Writing"))
											sawWritingAfterNext = true;
										const article = data.targets.find((t) =>
											/Ox Alpha/.test(t.label),
										);
										if (article)
											return { operation: "CLICK", target: article };
										return { operation: "DONE" };
									}
									if (data.url.includes("ox-alpha"))
										return { operation: "DONE" };
									const next = data.targets.find((t) => t.label === "Next");
									assert.ok(next);
									assert.equal(
										data.targets.some((t) => t.label === "Writing"),
										false,
									);
									return { operation: "CLICK", target: next };
								},
							},
						},
					);
					assert.equal(sawWritingAfterNext, false);
					assert.equal(result.status, "done_unverified");
				} finally {
					await page.unroute("https://example.test/**");
				}
			},
		);
		await t.test(
			"target=_blank careers links open in the same tab",
			async () => {
				await page.route("https://example.test/**", async (route) => {
					const path =
						new URL(route.request().url()).pathname.replace(/\/+$/, "") ||
						"/";
					const body =
						path === "/stockholm"
							? `<h1>Stockholm, Sweden careers</h1><p>Open roles in Stockholm.</p>`
							: `<a href="https://example.test/stockholm" target="_blank">Stockholm, Sweden</a>`;
					await route.fulfill({
						contentType: "text/html",
						body: `<!doctype html>${body}`,
					});
				});
				try {
					await page.goto("https://example.test/careers");
					const snapshot = await observe(page);
					try {
						const target = snapshot.data.targets.find((t) =>
							/Stockholm/.test(t.label),
						);
						assert.ok(target);
						await snapshot.execute(
							"CLICK",
							target,
							undefined,
							new AbortController().signal,
						);
					} finally {
						await snapshot.dispose();
					}
					assert.match(page.url(), /stockholm/);
					assert.equal(page.context().pages().length, 1);
				} finally {
					await page.unroute("https://example.test/**");
				}
			},
		);
		await t.test(
			"ARIA flight controls are offered with shared element IDs",
			async () => {
				await page.setContent(
					'<div role="combobox" aria-label="Trip type">Round trip</div><div role="menuitemradio" aria-checked="false">One way</div><div role="gridcell">September 20</div><input aria-label="Origin"><select aria-label="Cabin"><option>Economy</option><option>Business</option></select>',
				);
				const snapshot = await observe(page);
				try {
					for (const role of ["combobox", "menuitemradio", "gridcell"])
						assert.ok(snapshot.data.targets.some((t) => t.role === role));
					assert.equal(
						snapshot.data.targets.find((t) => t.role === "combobox")?.value,
						"Round trip",
					);
					const origin = snapshot.data.targets.filter(
						(t) => t.label === "Origin",
					);
					assert.equal(origin.length, 2);
					assert.equal(origin[0].id, origin[1].id);
					const option = snapshot.data.targets.find(
						(t) => t.operation === "SELECT",
					);
					assert.ok(option);
					await snapshot.execute(
						"SELECT",
						option,
						undefined,
						new AbortController().signal,
					);
					assert.equal(await page.locator("select").inputValue(), "Business");
				} finally {
					await snapshot.dispose();
				}
			},
		);
		await t.test(
			"low probability proceeds by default and history includes typed text and progress",
			async () => {
				await fixture();
				let calls = 0;
				const memory = { goal: "Search cats", actions: [] };
				const policy: JevPolicy = {
					async choose(data, _goal, history) {
						if (calls++ === 0)
							return {
								operation: "TYPE_TEXT",
								probability: 0.1,
								target: data.targets.find(
									(t) => t.operation === "TYPE_TEXT",
								),
							};
						assert.deepEqual(history, [
							{
								action: "Query",
								kind: "TYPE_TEXT",
								text: "cats",
								page_changed: true,
							},
						]);
						return { operation: "DONE" };
					},
				};
				const paused = await runJev(
					{ goal: "Search cats" },
					{ page: () => page, policy, memory },
				);
				assert.equal(paused.status, "needs_text");
				const result = await runJev(
					{ goal: "Search cats" },
					{ page: () => page, policy, memory, textReply: "cats" },
				);
				assert.equal(result.status, "done_unverified");
			},
		);
		await t.test("stale terminal decisions are re-evaluated", async () => {
			await fixture();
			let calls = 0;
			const result = await runJev(
				{ goal: "Search" },
				{
					page: () => page,
					policy: {
						async choose() {
							if (calls++ === 0) {
								await page.locator("#query").fill("new");
								return { operation: "DONE" };
							}
							return { operation: "BLOCKED" };
						},
					},
				},
			);
			assert.equal(result.status, "blocked");
			assert.equal(calls, 2);
		});
		await t.test(
			"replacement node with identical markup is rejected",
			async () => {
				await fixture();
				const snapshot = await observe(page);
				try {
					const target = snapshot.data.targets.find(
						(e) => e.label === "Search",
					);
					assert.ok(target);
					await page
						.locator("button")
						.evaluate((e) => e.replaceWith(e.cloneNode(true)));
					await assert.rejects(
						snapshot.execute(
							"CLICK",
							target,
							undefined,
							new AbortController().signal,
						),
						/disappeared/,
					);
				} finally {
					await snapshot.dispose();
				}
			},
		);
		await t.test(
			"stable targets survive unrelated changes but reject changed destinations",
			async () => {
				await page.setContent('<a href="#one">Buy</a><p id="ticker">1</p>');
				const snapshot = await observe(page);
				try {
					await page.locator("#ticker").evaluate((e) => (e.textContent = "2"));
					await snapshot.execute(
						"CLICK",
						snapshot.data.targets[0],
						undefined,
						new AbortController().signal,
					);
					assert.ok(page.url().endsWith("#one"));
				} finally {
					await snapshot.dispose();
				}
				const changed = await observe(page);
				try {
					await page
						.locator("a")
						.evaluate((e) => e.setAttribute("href", "#different"));
					await assert.rejects(
						changed.execute(
							"CLICK",
							changed.data.targets[0],
							undefined,
							new AbortController().signal,
						),
						/changed/,
					);
				} finally {
					await changed.dispose();
				}
			},
		);
		await t.test(
			"visible labels expose hidden radio options and their selected state",
			async () => {
				await page.setContent(
					'<input style="display:none" id="size" type="radio" name="size" value="small"><label for="size">Small $10</label><input style="display:none" id="disabled" type="radio" disabled><label for="disabled">Unavailable</label>',
				);
				const snapshot = await observe(page);
				try {
					const target = snapshot.data.targets.find(
						(t) => t.label === "Small $10",
					);
					assert.ok(target);
					assert.equal(target.role, "radio");
					assert.equal(target.checked, "false");
					assert.ok(
						!snapshot.data.targets.some((t) => t.label === "Unavailable"),
					);
					await snapshot.execute(
						"CLICK",
						target,
						undefined,
						new AbortController().signal,
					);
					assert.equal(await page.locator("#size").isChecked(), true);
				} finally {
					await snapshot.dispose();
				}
				const updated = await observe(page);
				try {
					assert.equal(
						updated.data.targets.find((t) => t.label === "Small $10")?.checked,
						"true",
					);
				} finally {
					await updated.dispose();
				}
			},
		);
		await t.test(
			"labels covered by their own input click the associated input",
			async () => {
				await page.setContent(
					'<div style="position:relative;width:180px;height:60px"><input id="option" type="radio" style="position:absolute;inset:0;width:100%;height:100%;opacity:0.01;z-index:2"><label for="option" style="display:block;width:100%;height:100%">No extras</label></div>',
				);
				const snapshot = await observe(page);
				try {
					const target = snapshot.data.targets.find(
						(t) => t.label === "No extras" && t.role === "radio",
					);
					assert.ok(target);
					await snapshot.execute(
						"CLICK",
						target,
						undefined,
						new AbortController().signal,
					);
					assert.ok(await page.locator("#option").isChecked());
				} finally {
					await snapshot.dispose();
				}
			},
		);
		await t.test(
			"offscreen choices guide scrolling while preserving selected options",
			async () => {
				await page.setContent(
					'<input id="chosen" type="radio" name="size" value="small" checked><label for="chosen">Small</label><div style="height:2000px"></div><input id="later" type="radio" name="carrier" value="later"><label for="later">Connect later</label><button disabled>Unavailable</button>',
				);
				const snapshot = await observe(page);
				try {
					assert.ok(
						snapshot.data.offscreenControls?.below.includes("Connect later"),
					);
					assert.ok(
						!snapshot.data.targets.some((t) => t.label === "Connect later"),
					);
					assert.ok(
						!snapshot.data.offscreenControls?.below.includes("Unavailable"),
					);
					assert.deepEqual(snapshot.data.selectedOptions, [
						{ group: "size", label: "Small", value: "small" },
					]);
				} finally {
					await snapshot.dispose();
				}
				await page.locator("#later").scrollIntoViewIfNeeded();
				const scrolled = await observe(page);
				try {
					assert.equal(scrolled.data.selectedOptions?.[0].value, "small");
					assert.ok(
						scrolled.data.targets.some((t) => t.label === "Connect later"),
					);
				} finally {
					await scrolled.dispose();
				}
			},
		);
		await t.test("covered targets are rejected", async () => {
			await fixture();
			const snapshot = await observe(page);
			try {
				await page.evaluate(() => {
					const cover = document.createElement("div");
					cover.style.cssText = "position:fixed;inset:0;z-index:999";
					document.body.append(cover);
				});
				await assert.rejects(
					snapshot.execute(
						"CLICK",
						snapshot.data.targets.find((e) => e.label === "Search"),
						undefined,
						new AbortController().signal,
					),
					/covered/,
				);
			} finally {
				await snapshot.dispose();
			}
		});
		await t.test(
			"review, uncertainty, limits, and cancellation stop the loop",
			async () => {
				for (const [operation, probability, expected] of [
					["REVIEW", 1, "needs_review"],
					["CLICK", 0.1, "uncertain"],
					["CLICK", undefined, "uncertain"],
					["WAIT", 1, "step_limit"],
				] as const) {
					await fixture();
					const result = await runJev(
						{ goal: "Search", maxSteps: 1, minProbability: 0.6 },
						{
							page: () => page,
							policy: {
								async choose() {
									return { operation, probability };
								},
							},
						},
					);
					assert.equal(result.status, expected);
				}
				const controller = new AbortController();
				const result = await runJev(
					{ goal: "Search" },
					{
						page: () => page,
						signal: controller.signal,
						policy: {
							async choose(data) {
								controller.abort();
								return {
									operation: "CLICK",
									probability: 1,
									target: data.targets.find((e) => e.label === "Search"),
								};
							},
						},
					},
				);
				assert.equal(result.status, "interrupted");
				assert.equal(result.steps.length, 0);
			},
		);
	} finally {
		await browser.close();
	}
});
