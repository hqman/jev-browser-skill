import { waitForDocument } from "./jev-browser.ts";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	type CDPSession,
	chromium,
	type Page,
} from "playwright";
import { executeActions } from "./actions.ts";
import { ensureChromium } from "./browser-setup.ts";
import { isUrlAllowed, readConfig } from "./config.ts";
import { type RunInput, type RunMemory, runJev } from "./jev-run.ts";
import { installRecordingOverlay } from "./recording-overlay.ts";
import { startStream, stopStream } from "./stream.ts";
import type {
	ActiveBrowserSession,
	BrowserAction,
	BrowserLogEntry,
	BrowserState,
	JevBrowserConfig,
	ToolContext,
} from "./types.ts";

interface BrowserRunInput extends RunInput {
	url?: string;
	headless?: boolean;
	recordVideo?: boolean;
	showCursor?: boolean;
	showClickIndicators?: boolean;
	textReply?: string;
}

type HostBridge = { emitEvent?: (name: string, payload?: unknown) => void };

export class JevBrowserManager {
	private readonly sessions = new Map<string, ActiveBrowserSession>();
	private readonly jevMemory = new WeakMap<ActiveBrowserSession, RunMemory>();
	private readonly running = new Map<string, AbortController>();
	private readonly starting = new Map<string, Promise<unknown>>();

	private async startBrowser(
		input: {
			url?: string;
			headless?: boolean;
			recordVideo?: boolean;
			showCursor?: boolean;
			showClickIndicators?: boolean;
		},
		context: ToolContext,
		signal: AbortSignal,
	) {
		const key = sessionKey(context);
		await this.stopByKey(key).catch(() => undefined);
		signal.throwIfAborted();
		const config = readConfig();
		const url = input.url?.trim() || "about:blank";
		assertUrlAllowed(url, config);
		const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
		const outputDir = join(config.outputDir, safePathPart(key), id);
		await mkdir(join(outputDir, "screenshots"), { recursive: true });
		if (input.recordVideo ?? config.recordVideo)
			await mkdir(join(outputDir, "videos"), { recursive: true });

		await ensureChromium();

		const requestedHeadless = input.headless ?? config.headless;
		const launchOptions = {
			// On macOS, forcing Chromium's Linux sandbox can deadlock or crash when
			// the host process is an app or plugin subprocess. The full Chromium
			// channel keeps its native platform sandbox and supports modern headless.
			...(process.platform === "darwin"
				? { channel: "chromium" as const }
				: { chromiumSandbox: true }),
			timeout: 20_000,
			env: {},
			args: [
				"--disable-extensions",
				"--disable-file-system",
				`--window-size=${config.viewport.width},${config.viewport.height}`,
			],
		};
		let actualHeadless = requestedHeadless;
		let launchWarning: string | undefined;
		let browser: Browser | undefined;
		let browserContext: BrowserContext | undefined;
		let session: ActiveBrowserSession | undefined;
		try {
			try {
				browser = await chromium.launch({
					...launchOptions,
					headless: requestedHeadless,
				});
			} catch (error) {
				if (process.platform !== "darwin" || !requestedHeadless) throw error;
				// Headless Chromium may be rejected by the macOS app sandbox even though
				// a normal browser window is allowed. Fall back instead of consuming the
				// entire plugin call timeout.
				browser = await chromium.launch({ ...launchOptions, headless: false });
				actualHeadless = false;
				launchWarning =
					"Headless Chromium was unavailable, so a visible browser window was started.";
			}
			signal.throwIfAborted();
			browserContext = await browser.newContext({
				viewport: config.viewport,
				acceptDownloads: false,
				serviceWorkers: "block",
				...((input.recordVideo ?? config.recordVideo)
					? {
							recordVideo: {
								dir: join(outputDir, "videos"),
								size: config.viewport,
							},
						}
					: {}),
			});
			signal.throwIfAborted();
			await installRecordingOverlay(browserContext, {
				showCursor: input.showCursor ?? config.showCursor,
				showClickIndicators:
					input.showClickIndicators ?? config.showClickIndicators,
			});
			signal.throwIfAborted();
			const page = await browserContext.newPage();
			signal.throwIfAborted();
			session = {
				browser,
				context: browserContext,
				page,
				video: page.video() ?? undefined,
				id,
				outputDir,
				startedAt: new Date().toISOString(),
				logs: [],
				nextLogId: 1,
				navigationGuards: new WeakMap(),
			};
			this.sessions.set(key, session);
			await this.attachObservability(session, config);
			signal.throwIfAborted();
			if (url !== "about:blank")
				await page.goto(url, {
					waitUntil: "domcontentloaded",
					timeout: 20_000,
				});
			if (config.stream.enabled)
				await this.startStreamForSession(session, config.stream.intervalMs);
			signal.throwIfAborted();
		} catch (error) {
			if (session && this.sessions.get(key) === session)
				this.sessions.delete(key);
			if (session) await settleWithin(stopStream(session), 3_000);
			await settleWithin(browserContext?.close(), 8_000);
			await settleWithin(browser?.close(), 3_000);
			throw error;
		}

		const state = await this.stateForSession(session, config);
		emitHostUpdate("started", {
			state,
			outputDir,
			streamUrl: session.stream?.url,
			actualHeadless,
			launchWarning,
		});
		return {
			...state,
			outputDir,
			streamUrl: session.stream?.url,
			actualHeadless,
			launchWarning,
			message: "Browser started.",
		};
	}

	async screenshot(input: { label?: string }, context: ToolContext) {
		const session = this.requireSession(context);
		const config = readConfig();
		const label = sanitizeLabel(input.label ?? "screenshot");
		const path = join(
			session.outputDir,
			"screenshots",
			`${Date.now()}-${label}.png`,
		);
		await waitForDocument(session.page);
		await capturePagePng(session.page, path);
		const state = await this.stateForSession(session, config);
		emitHostUpdate("screenshot", { state, path });
		return screenshotResult(state, path);
	}

	async actions(
		input: { actions: BrowserAction[]; includeScreenshot?: boolean },
		context: ToolContext,
	) {
		this.assertNotRunning(context);
		const session = this.requireSession(context);
		const config = readConfig();
		const key = sessionKey(context);
		const controller = new AbortController();
		this.running.set(key, controller);
		try {
			await executeActions(session.page, input.actions, {
				assertUrlAllowed: (url) => assertUrlAllowed(url, config),
				signal: AbortSignal.any([
					controller.signal,
					AbortSignal.timeout(115_000),
				]),
			});
			const state = await this.stateForSession(session, config);
			emitHostUpdate("actions", {
				actionTypes: input.actions.map((action) => action.type),
				state,
			});
			if (input.includeScreenshot === false) {
				return { state, executed: input.actions.map((action) => action.type) };
			}
			return this.screenshot({ label: "after-actions" }, context);
		} finally {
			this.running.delete(key);
		}
	}

	async run(input: BrowserRunInput, context: ToolContext) {
		this.assertNotRunning(context);
		const key = sessionKey(context);
		const controller = new AbortController();
		this.running.set(key, controller);
		try {
			if (!this.sessions.has(key)) {
				const starting = this.startBrowser(input, context, controller.signal);
				this.starting.set(key, starting);
				try {
					await starting;
				} finally {
					if (this.starting.get(key) === starting) this.starting.delete(key);
				}
			}
			else if (input.url) {
				assertUrlAllowed(input.url, readConfig());
				await this.requireSession(context).page.goto(input.url, {
					waitUntil: "domcontentloaded",
					timeout: 20_000,
				});
			}
			return await this.drive(input, context, controller);
		} finally {
			this.running.delete(key);
		}
	}

	async reply(input: { text: string; maxSteps?: number }, context: ToolContext) {
		this.assertNotRunning(context);
		const key = sessionKey(context);
		if (!this.sessions.has(key)) {
			throw new Error(
				"No browser is open for this session. Leave it open after needs_text.",
			);
		}
		const controller = new AbortController();
		this.running.set(key, controller);
		try {
			const session = this.requireSession(context);
			const memory = this.jevMemory.get(session);
			if (!memory?.pendingText) {
				throw new Error(
					"No text question is waiting. Run until status is needs_text.",
				);
			}
			return await this.drive(
				{
					goal: memory.goal,
					maxSteps: input.maxSteps,
					textReply: input.text,
				},
				context,
				controller,
			);
		} finally {
			this.running.delete(key);
		}
	}

	private async drive(
		input: BrowserRunInput,
		context: ToolContext,
		controller: AbortController,
	) {
		controller.signal.throwIfAborted();
		const session = this.requireSession(context);
		const tracePath = join(session.outputDir, `jev-${randomUUID()}.jsonl`);
		const initial = input.textReply
			? undefined
			: await this.screenshot({ label: "jev-initial" }, context).catch(
					() => undefined,
				);
		const memory = this.jevMemory.get(session) ?? {
			goal: input.goal,
			actions: [],
		};
		this.jevMemory.set(session, memory);
		const result = await runJev(input, {
			memory,
			textReply: input.textReply,
			page: () => session.page,
			signal: controller.signal,
			onStep: async (step) => {
				await appendFile(tracePath, `${JSON.stringify(step)}\n`);
				emitHostUpdate("jev-step", step);
			},
		});
		await appendFile(
			tracePath,
			`${JSON.stringify({ type: "result", ...result })}\n`,
		);
		let final:
			| Awaited<ReturnType<JevBrowserManager["screenshot"]>>
			| undefined;
		try {
			final = await this.screenshot({ label: "jev-final" }, context);
		} catch {
			/* Browser may have been stopped during cancellation. */
		}
		if (final?.state.currentUrl) {
			await appendFile(
				tracePath,
				`${JSON.stringify({
					type: "found",
					url: final.state.currentUrl,
					title: final.state.pageTitle,
				})}\n`,
			);
		}
		return {
			...result,
			url: final?.state.currentUrl,
			title: final?.state.pageTitle,
			tracePath,
			initialScreenshot: initial
				? {
						artifactPath: initial.artifactPath,
						state: initial.state,
					}
				: null,
			finalScreenshot: final
				? { artifactPath: final.artifactPath, state: final.state }
				: null,
			screenshotWarning: final
				? undefined
				: "Final screenshot unavailable; the browser may have closed. Outcome is unverified.",
			result: final?.result,
		};
	}

	private assertNotRunning(context: ToolContext) {
		if (this.running.has(sessionKey(context)))
			throw new Error(
				"A browser operation is active for this session. Wait or cancel it before issuing another browser mutation.",
			);
	}

	async state(context: ToolContext) {
		const session = this.sessions.get(sessionKey(context));
		return session
			? this.stateForSession(session, readConfig())
			: ({
					active: false,
					pages: [],
					viewport: readConfig().viewport,
				} satisfies BrowserState);
	}

	logs(input: { afterId?: number; limit?: number }, context: ToolContext) {
		const session = this.requireSession(context);
		const afterId = Number.isFinite(input.afterId) ? Number(input.afterId) : 0;
		const limit = Math.min(1000, Math.max(1, Number(input.limit) || 200));
		const logs = session.logs
			.filter((entry) => entry.id > afterId)
			.slice(-limit);
		return {
			logs,
			lastId: logs.at(-1)?.id ?? afterId,
			total: session.logs.length,
		};
	}

	async stream(
		input: { action: "start" | "status" | "stop"; intervalMs?: number },
		context: ToolContext,
	) {
		const session = this.requireSession(context);
		if (input.action === "stop") {
			await stopStream(session);
			return { active: false };
		}
		if (input.action === "start" && !session.stream) {
			await this.startStreamForSession(
				session,
				Math.min(
					10_000,
					Math.max(250, input.intervalMs ?? readConfig().stream.intervalMs),
				),
			);
		}
		return { active: Boolean(session.stream), url: session.stream?.url };
	}

	async stop(context: ToolContext) {
		const key = sessionKey(context);
		this.running.get(key)?.abort();
		await this.starting.get(key)?.catch(() => undefined);
		return this.stopByKey(key);
	}

	private async stopByKey(key: string) {
		const session = this.sessions.get(key);
		if (!session)
			return {
				active: false,
				message: "No browser is active for this session.",
			};
		this.sessions.delete(key);
		await settleWithin(stopStream(session), 3_000);
		await settleWithin(session.context.close(), 8_000);
		let videoPath: string | undefined;
		try {
			videoPath = await withTimeout(
				session.video?.path(),
				8_000,
				"Video finalization",
			);
		} catch {
			videoPath = undefined;
		}
		await settleWithin(session.browser.close(), 3_000);
		emitHostUpdate("stopped", { outputDir: session.outputDir, videoPath });
		return { active: false, outputDir: session.outputDir, videoPath };
	}

	private requireSession(context: ToolContext) {
		const session = this.sessions.get(sessionKey(context));
		if (!session)
			throw new Error(
				"No browser is active. Call `jb run` with a goal and initial URL first.",
			);
		return session;
	}

	private async stateForSession(
		session: ActiveBrowserSession,
		config: JevBrowserConfig,
	): Promise<BrowserState> {
		const pages = await Promise.all(
			session.context.pages().map(async (page, index) => ({
				index,
				title: await page.title().catch(() => ""),
				url: page.url(),
			})),
		);
		return {
			active: true,
			currentUrl: session.page.url(),
			pageTitle: await session.page.title().catch(() => ""),
			pages,
			startedAt: session.startedAt,
			viewport: config.viewport,
		};
	}

	private async attachObservability(
		session: ActiveBrowserSession,
		config: JevBrowserConfig,
	) {
		void session.context.route("**/*", async (route) => {
			const request = route.request();
			if (
				request.isNavigationRequest() &&
				!isUrlAllowed(request.url(), config.allowedOrigins)
			) {
				this.addLog(session, {
					type: "security",
					level: "blocked",
					text: "Blocked navigation outside allowedOrigins.",
					url: request.url(),
				});
				await route.abort("blockedbyclient");
				return;
			}
			if (request.isNavigationRequest()) {
				await this.ensureNavigationGuard(session, request.frame().page(), config);
			}
			await route.continue();
		});

		const attachPage = (page: Page) => {
			page.on("console", (message) =>
				this.addLog(session, {
					type: "console",
					level: message.type(),
					text: message.text(),
					url: page.url(),
				}),
			);
			page.on("pageerror", (error) =>
				this.addLog(session, {
					type: "pageerror",
					level: "error",
					text: error.message,
					url: page.url(),
				}),
			);
			page.on("requestfailed", (request) =>
				this.addLog(session, {
					type: "requestfailed",
					level: "error",
					text: request.failure()?.errorText ?? "Request failed",
					url: request.url(),
				}),
			);
			page.on("download", (download) =>
				this.addLog(session, {
					type: "download",
					level: "blocked",
					text: `Download blocked: ${download.suggestedFilename()}`,
					url: page.url(),
				}),
			);
			page.on("framenavigated", (frame) => {
				if (frame === page.mainFrame())
					this.addLog(session, {
						type: "navigation",
						level: "info",
						text: frame.url(),
						url: frame.url(),
					});
			});
		};
		attachPage(session.page);
		await this.ensureNavigationGuard(session, session.page, config);
		session.context.on("page", (page) => {
			attachPage(page);
			void this.ensureNavigationGuard(session, page, config).catch(() =>
				page.close().catch(() => undefined),
			);
			session.page = page;
		});
	}

	private ensureNavigationGuard(
		session: ActiveBrowserSession,
		page: Page,
		config: JevBrowserConfig,
	): Promise<CDPSession> {
		const existing = session.navigationGuards?.get(page);
		if (existing) return existing;
		const installing = (async () => {
			const cdp = await session.context.newCDPSession(page);
			cdp.on("Fetch.requestPaused", (event) => {
				const allowed = isUrlAllowed(event.request.url, config.allowedOrigins);
				if (!allowed) {
					this.addLog(session, {
						type: "security",
						level: "blocked",
						text: "Blocked navigation outside allowedOrigins.",
						url: event.request.url,
					});
				}
				void cdp
					.send(
						allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
						allowed
							? { requestId: event.requestId }
							: {
									requestId: event.requestId,
									errorReason: "BlockedByClient",
								},
					)
					.catch(() => undefined);
			});
			await cdp.send("Fetch.enable", {
				patterns: [
					{
						urlPattern: "*",
						resourceType: "Document",
						requestStage: "Request",
					},
				],
			});
			return cdp;
		})();
		session.navigationGuards?.set(page, installing);
		return installing;
	}

	private addLog(
		session: ActiveBrowserSession,
		input: Omit<BrowserLogEntry, "id" | "timestamp">,
	) {
		const entry: BrowserLogEntry = {
			id: session.nextLogId++,
			timestamp: new Date().toISOString(),
			...input,
		};
		session.logs.push(entry);
		if (session.logs.length > 5000)
			session.logs.splice(0, session.logs.length - 5000);
		emitHostUpdate("log", entry);
	}

	private async startStreamForSession(
		session: ActiveBrowserSession,
		intervalMs: number,
	) {
		const stream = await startStream(session, { intervalMs });
		emitHostUpdate("stream", { url: stream.url });
	}
}

async function capturePagePng(page: Page, path: string) {
	try {
		await page.screenshot({
			path,
			type: "png",
			timeout: 8_000,
			animations: "disabled",
		});
	} catch {
		const cdp = await page.context().newCDPSession(page);
		try {
			const captured = await cdp.send("Page.captureScreenshot", {
				format: "png",
				fromSurface: true,
			});
			await writeFile(path, Buffer.from(captured.data, "base64"));
		} finally {
			await cdp.detach().catch(() => undefined);
		}
	}
}

function screenshotResult(state: BrowserState, artifactPath: string) {
	return {
		state,
		artifactPath,
		result: [
			{
				type: "text",
				text: `Screenshot captured at ${artifactPath}. Current URL: ${state.currentUrl ?? "unknown"}`,
			},
		],
	};
}

function assertUrlAllowed(url: string, config: JevBrowserConfig) {
	if (!isUrlAllowed(url, config.allowedOrigins)) {
		throw new Error(
			`Navigation blocked by ~/.jb/config.json: ${url}`,
		);
	}
}

function sessionKey(context: ToolContext) {
	return context.sessionId || "default";
}

function safePathPart(value: string) {
	return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180) || "default";
}

function sanitizeLabel(value: string) {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 64) || "screenshot"
	);
}

function emitHostUpdate(type: string, payload: unknown) {
	(
		globalThis as typeof globalThis & { __jbHost?: HostBridge }
	).__jbHost?.emitEvent?.("jev_browser_update", { type, payload });
}

async function settleWithin(
	promise: Promise<unknown> | undefined,
	timeoutMs: number,
) {
	if (!promise) return;
	await withTimeout(promise, timeoutMs, "Browser cleanup").catch(
		() => undefined,
	);
}

async function withTimeout<T>(
	promise: Promise<T> | undefined,
	timeoutMs: number,
	label: string,
): Promise<T | undefined> {
	if (!promise) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
