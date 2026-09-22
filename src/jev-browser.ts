import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";

export type TargetOperation = "CLICK" | "TYPE_TEXT" | "SELECT";
export interface ObservedTarget {
	id: string;
	operation: TargetOperation;
	label: string;
	value: string;
	option?: string;
	role?: string;
	checked?: string;
	selected?: string;
	expanded?: string;
	href?: string;
}
export interface Observation {
	url: string;
	title: string;
	text: string;
	targets: ObservedTarget[];
	offscreenControls?: { above: string[]; below: string[] };
	selectedOptions?: Array<{ group: string; label: string; value: string }>;
	scrollUp: boolean;
	scrollDown: boolean;
}

export class StaleObservationError extends Error {}

// The closure retains actual nodes, outside page globals. Model output can only
// select an offered ID; it never becomes a selector or executable browser code.
export function isNavigationReadError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/Execution context was destroyed|Cannot find context with specified id|JSHandle is disposed|Unable to adopt element handle from a different document/.test(
			error.message,
		)
	);
}

function isDocumentNotReadyError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "TimeoutError" ||
			error.message.includes("JEV_DOCUMENT_NOT_READY"))
	);
}

// Wait for a usable document, not network-idle (many sites keep requests open).
export async function waitForDocument(page: Page, signal?: AbortSignal) {
	signal?.throwIfAborted();
	try {
		const ready = await page.waitForFunction(
			() => document.readyState !== "loading" && document.body !== null,
			undefined,
			{ timeout: 10_000 },
		);
		await ready.dispose();
	} catch (error) {
		// Playwright times out instead of throwing JEV_DOCUMENT_NOT_READY when the
		// next document is still loading after a click-triggered navigation.
		if (error instanceof Error && error.name === "TimeoutError")
			throw new Error("JEV_DOCUMENT_NOT_READY");
		throw error;
	}
	signal?.throwIfAborted();
}

// Retry only reads invalidated by document replacement, never a browser action.
export async function observe(page: Page, signal?: AbortSignal) {
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		try {
			await waitForDocument(page, signal);
			return await observeDocument(page);
		} catch (error) {
			if (
				page.isClosed() ||
				(!isNavigationReadError(error) && !isDocumentNotReadyError(error)) ||
				attempt >= 4
			)
				throw error;
			await delay(250, undefined, { signal });
		}
	}
}

async function observeDocument(page: Page) {
	const handle = await page.evaluateHandle(() => {
		const selector =
			'label[for],a[href],button,input,textarea,select,summary,[contenteditable="true"],[role="button"],[role="link"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="combobox"],[role="gridcell"],[role="menuitemradio"],[role="textbox"],[role="searchbox"],[role="spinbutton"]';
		const visible = (e: HTMLElement) => {
			const r = e.getBoundingClientRect();
			return (
				e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
				!e.closest('[inert],[aria-hidden="true"]') &&
				r.width > 0 &&
				r.height > 0 &&
				r.top + r.height / 2 >= 0 &&
				r.left + r.width / 2 >= 0 &&
				r.top + r.height / 2 < innerHeight &&
				r.left + r.width / 2 < innerWidth
			);
		};
		const receivesPointer = (e: HTMLElement) => {
			const r = e.getBoundingClientRect();
			const hit = document.elementFromPoint(
				r.x + r.width / 2,
				r.y + r.height / 2,
			);
			return (
				e.contains(hit) ||
				(e instanceof HTMLLabelElement && !!e.control?.contains(hit))
			);
		};

		const isSkippedMedia = (e: HTMLElement) => {
			if (e.closest("video, audio")) return true;
			const href =
				e instanceof HTMLAnchorElement
					? e.href
					: (e.getAttribute("href") ?? "");
			if (/\.(mp4|webm|mov|m4v|ogv|mp3|wav|ogg)(\?|#|$)/i.test(href))
				return true;
			if (e.querySelector("video, audio")) {
				if (
					!href ||
					href === location.href ||
					href.endsWith("#") ||
					/\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(href)
				)
					return true;
			}
			const r = e.getBoundingClientRect();
			const hit = document.elementFromPoint(
				r.x + r.width / 2,
				r.y + r.height / 2,
			);
			if (hit?.closest("video, audio")) return true;
			const name = (e.getAttribute("aria-label") || "").trim();
			return /^(play|pause|mute|unmute|replay|fullscreen|captions)$/i.test(
				name,
			);
		};

		const isSkippedListingNav = (e: HTMLElement) => {
			const current = e.getAttribute("aria-current");
			if (current === "page" || current === "true") return true;
			const href =
				e instanceof HTMLAnchorElement
					? e.href
					: (e.getAttribute("href") ?? "");
			if (!href) return false;
			try {
				const dest = new URL(href, location.href);
				if (dest.origin !== location.origin) return false;
				const destPath = dest.pathname.replace(/\/+$/, "") || "/";
				const herePath = location.pathname.replace(/\/+$/, "") || "/";
				const destKey = `${dest.origin}${destPath}${dest.search}`;
				const hereKey = `${location.origin}${herePath}${location.search}`;
				if (destKey === hereKey && !dest.hash) return true;
				return (
					herePath.startsWith(`${destPath}/`) &&
					/^\/\d+$/.test(herePath.slice(destPath.length)) &&
					!dest.search &&
					!dest.hash
				);
			} catch {
				return false;
			}
		};

		const read = () => {
			if (!document.body || document.readyState === "loading")
				throw new Error("JEV_DOCUMENT_NOT_READY");
			const nodes: HTMLElement[] = [];
			const targets: ObservedTarget[] = [];
			const offscreenControls = {
				above: [] as string[],
				below: [] as string[],
			};
			for (const e of document.querySelectorAll<HTMLElement>(selector)) {
				if (targets.length >= 200) break;
				const rect = e.getBoundingClientRect();
				const associated = e instanceof HTMLLabelElement ? e.control : e;
				if (
					associated &&
					associated.matches(
						"input,select,textarea,[role=radio],[role=checkbox],[role=combobox]",
					) &&
					!associated.matches(":disabled,:checked") &&
					!e.closest('[inert],[aria-hidden="true"],[aria-disabled="true"]') &&
					e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
					rect.width > 0 &&
					rect.height > 0
				) {
					const direction =
						rect.bottom <= 0
							? "above"
							: rect.top >= innerHeight
								? "below"
								: undefined;
					if (direction && offscreenControls[direction].length < 50) {
						const name = (
							e.getAttribute("aria-label") ||
							e.innerText ||
							e.getAttribute("title") ||
							""
						)
							.trim()
							.slice(0, 300);
						if (name && !offscreenControls[direction].includes(name))
							offscreenControls[direction].push(name);
					}
				}

				if (
					!visible(e) ||
					!receivesPointer(e) ||
					e.matches(":disabled") ||
					e.closest('[aria-disabled="true"]') ||
					isSkippedMedia(e) ||
					isSkippedListingNav(e)
				)
					continue;
				if (
					e.getAttribute("role") === "gridcell" &&
					e.querySelector("button,[role=button]")
				)
					continue;
				const control = e instanceof HTMLLabelElement ? e.control : e;
				if (!control || control.matches(":disabled")) continue;
				const input = control as HTMLInputElement;
				if (["password", "file", "hidden"].includes(input.type)) continue;
				const label = (
					e.getAttribute("aria-label") ||
					(e.getAttribute("aria-labelledby") || "")
						.split(/\s+/)
						.map((id) => document.getElementById(id)?.textContent || "")
						.join(" ")
						.trim() ||
					Array.from(input.labels || [])
						.map((l) => l.textContent)
						.join(" ") ||
					e.innerText ||
					e.getAttribute("placeholder") ||
					e.getAttribute("title") ||
					input.type ||
					e.tagName
				)
					.trim()
					.slice(0, 300);
				const value = String(
					input.value ??
						(e.isContentEditable || e.getAttribute("role") === "combobox"
							? e.innerText
							: ""),
				);
				const nodeId = String(new Set(nodes).size + 1);
				const add = (
					operation: TargetOperation,
					option?: string,
					optionLabel?: string,
					optionIndex?: number,
				) => {
					nodes.push(e);
					targets.push({
						id: option !== undefined ? `${nodeId}:${optionIndex}` : nodeId,
						operation,
						label: optionLabel ? `${label} → ${optionLabel}` : label,
						value: value.slice(0, 1000),
						role:
							control.getAttribute("role") ||
							(["radio", "checkbox"].includes(input.type)
								? input.type
								: e.tagName.toLowerCase()),
						href: e instanceof HTMLAnchorElement ? e.href : undefined,
						checked:
							e.getAttribute("aria-checked") ??
							(["checkbox", "radio"].includes(input.type)
								? String(input.checked)
								: undefined),
						selected: e.getAttribute("aria-selected") ?? undefined,
						expanded: e.getAttribute("aria-expanded") ?? undefined,
						...(option !== undefined ? { option } : {}),
					});
				};
				if (e instanceof HTMLSelectElement) {
					for (const o of e.options) {
						if (targets.length >= 200) break;
						if (!o.selected && !o.disabled && !o.closest("optgroup[disabled]"))
							add("SELECT", o.value, o.label, o.index);
					}
				} else {
					const editable =
						!input.readOnly &&
						e.getAttribute("aria-readonly") !== "true" &&
						(e instanceof HTMLTextAreaElement ||
							e.isContentEditable ||
							(e instanceof HTMLInputElement &&
								["text", "search", "email", "url", "tel", "number"].includes(
									e.type,
								)));
					// An editable field is reached through TYPE_TEXT (execute focuses
					// it); offering CLICK too invites click-the-field-again loops.
					if (editable) add("TYPE_TEXT");
					else add("CLICK");
				}
			}
			const words: string[] = [];
			const walker = document.createTreeWalker(
				document.body,
				NodeFilter.SHOW_TEXT,
			);
			const range = document.createRange();
			let length = 0;
			while (length < 6000) {
				const node = walker.nextNode();
				if (!node) break;
				const parent = node.parentElement;
				const text = node.textContent?.trim();
				if (
					!text ||
					!parent ||
					parent.closest(
						'script,style,noscript,[inert],[aria-hidden="true"]',
					) ||
					!parent.checkVisibility({
						checkOpacity: true,
						checkVisibilityCSS: true,
					})
				)
					continue;
				range.selectNodeContents(node);
				const r = range.getBoundingClientRect();
				if (
					r.width &&
					r.height &&
					r.bottom > 0 &&
					r.top < innerHeight &&
					r.right > 0 &&
					r.left < innerWidth
				) {
					words.push(text);
					length += text.length;
				}
			}
			const data: Observation = {
				offscreenControls,
				selectedOptions: Array.from(
					document.querySelectorAll<HTMLInputElement>(
						"input[type=radio]:checked,input[type=checkbox]:checked",
					),
				)
					.filter((e) => !e.closest('[aria-hidden="true"],[inert]'))
					.slice(0, 50)
					.map((e) => ({
						group: e.name,
						label: Array.from(e.labels ?? [])
							.map((l) => l.textContent?.trim() ?? "")
							.join(" ")
							.slice(0, 300),
						value: e.value,
					})),
				url: location.href,
				title: document.title,
				text: words.join("\n").slice(0, 6000),
				targets,
				scrollUp: scrollY > 0,
				scrollDown:
					scrollY + innerHeight < document.documentElement.scrollHeight - 2,
			};
			// Include form/ARIA state and link destinations even when they don't alter labels.
			const signature = JSON.stringify([
				data,
				scrollX,
				scrollY,
				nodes.map((e) => [
					e.getAttribute("href"),
					e.getAttribute("aria-checked"),
					e.getAttribute("aria-selected"),
					e.getAttribute("aria-expanded"),
					(e as HTMLInputElement).checked,
					(e as HTMLInputElement).value,
					(e as HTMLInputElement).readOnly,
					e.getAttribute("aria-readonly"),
				]),
			]);
			const formState = JSON.stringify(
				Array.from(
					document.querySelectorAll(
						'input,textarea,select,[contenteditable="true"]',
					),
				).map((e) => [
					(e as HTMLInputElement).value,
					(e as HTMLInputElement).checked,
					e.getAttribute("aria-checked"),
				]),
			);
			const links = nodes.map((e) => e.getAttribute("href"));
			return { nodes, data, signature, formState, links };
		};
		const original = read();
		return { original, read };
	});
	try {
		const data = await handle.evaluate((h) => h.original.data);
		return {
			data,
			async assertFresh() {
				const fresh = await handle.evaluate((h) => {
					const current = h.read();
					return (
						current.signature === h.original.signature &&
						current.nodes.length === h.original.nodes.length &&
						current.nodes.every((e, i) => e === h.original.nodes[i])
					);
				});
				if (!fresh)
					throw new StaleObservationError(
						"Page changed; observe again before acting.",
					);
			},
			async execute(
				operation: string,
				target: ObservedTarget | undefined,
				text: string | undefined,
				signal: AbortSignal,
			) {
				signal.throwIfAborted();
				if (operation === "ENTER" && target === undefined) {
					await page.keyboard.press("Enter");
					await page
						.waitForLoadState("domcontentloaded", { timeout: 15_000 })
						.catch(() => undefined);
					return;
				}
				const nodeHandle = await handle
					.evaluateHandle((h, target) => {
						const current = h.read();
						if (target === undefined || target.operation === "TYPE_TEXT") {
							if (
								current.signature !== h.original.signature ||
								current.nodes.length !== h.original.nodes.length ||
								current.nodes.some((e, i) => e !== h.original.nodes[i])
							)
								throw new Error("Page changed; observe again before acting.");
						}
						if (target === undefined) return null;
						const index = h.original.data.targets.findIndex(
							(t) => t.id === target.id && t.operation === target.operation,
						);
						const node = h.original.nodes[index];
						if (!node?.isConnected)
							throw new Error("Observed target disappeared.");
						const currentIndex = current.nodes.findIndex(
							(e, i) =>
								e === node &&
								current.data.targets[i]?.operation === target.operation &&
								current.data.targets[i]?.option === target.option,
						);
						if (currentIndex < 0)
							throw new Error("Observed target is covered or unavailable.");
						const before = h.original.data.targets[index];
						const after = current.data.targets[currentIndex];
						if (
							current.data.url !== h.original.data.url ||
							current.formState !== h.original.formState ||
							current.links[currentIndex] !== h.original.links[index] ||
							JSON.stringify({ ...before, id: null }) !==
								JSON.stringify({ ...after, id: null })
						)
							throw new Error("Page changed; target or form state changed.");
						const r = node.getBoundingClientRect();
						const hit = document.elementFromPoint(
							r.x + r.width / 2,
							r.y + r.height / 2,
						);
						if (
							!node.contains(hit) &&
							!(node instanceof HTMLLabelElement && node.control?.contains(hit))
						)
							throw new Error("Observed target is covered.");
						return node instanceof HTMLLabelElement &&
							node.control?.contains(hit)
							? node.control
							: node;
					}, target)
					.catch((error) => {
						if (
							/Page changed;|Observed target disappeared|Observed target is covered/.test(
								String(error),
							)
						)
							throw new StaleObservationError(String(error));
						throw error;
					});
				try {
					signal.throwIfAborted();
					const element = nodeHandle.asElement();
					// A failed mutation is never retried by this loop.
					if (operation === "CLICK" && element) {
						const dest = await element
							.evaluate((el) => {
								if (!(el instanceof HTMLAnchorElement) || !el.href)
									return null;
								const blank =
									el.target === "_blank" || el.target === "_new";
								if (blank) el.target = "_self";
								return { href: el.href, blank };
							})
							.catch(() => null);
						await element.click({ timeout: 10000, noWaitAfter: true });
						if (dest?.blank && dest.href) {
							try {
								await page.waitForURL(dest.href, { timeout: 8_000 });
							} catch {
								if (page.url() !== dest.href) {
									await page.goto(dest.href, {
										waitUntil: "domcontentloaded",
										timeout: 20_000,
									});
								}
							}
						} else {
							await page
								.waitForLoadState("domcontentloaded", { timeout: 15_000 })
								.catch(() => undefined);
						}
					}
					else if (operation === "TYPE_TEXT" && element && text !== undefined) {
						await element.fill(text, { timeout: 2000 });
						const role = await element.evaluate(
							(el) =>
								el.getAttribute("role") ||
								(el instanceof HTMLInputElement ? el.type : ""),
						);
						if (role === "combobox" || role === "searchbox" || role === "search") {
							const deadline = Date.now() + 400;
							while (Date.now() < deadline) {
								signal.throwIfAborted();
								if (
									await page.evaluate(
										() =>
											!!document.querySelector(
												'[role="option"],[role="listbox"]',
											),
									)
								)
									break;
								await delay(50, undefined, { signal });
							}
						}
					} else if (
						operation === "SELECT" &&
						element &&
						target?.option !== undefined
					)
						await element.selectOption(target.option, { timeout: 2000 });
					else if (operation === "SCROLL_DOWN" || operation === "SCROLL_UP")
						await page.evaluate(
							(direction) =>
								window.scrollBy({
									top: direction * innerHeight * 0.5,
									behavior: "instant",
								}),
							operation === "SCROLL_DOWN" ? 1 : -1,
						);
					else if (operation === "WAIT")
						await new Promise((resolve) => setTimeout(resolve, 150));
					else if (operation === "ENTER") {
						if (element) await element.press("Enter", { noWaitAfter: true });
						else await page.keyboard.press("Enter");
						await page
							.waitForLoadState("domcontentloaded", { timeout: 15_000 })
							.catch(() => undefined);
					} else throw new Error("Unsupported observed action.");
				} finally {
					await nodeHandle.dispose();
				}
			},
			dispose: () => handle.dispose(),
		};
	} catch (error) {
		await handle.dispose().catch(() => undefined);
		throw error;
	}
}
