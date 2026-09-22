import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import type { BrowserAction } from "./types.ts";

export async function executeActions(
	page: Page,
	actions: BrowserAction[],
	options: { assertUrlAllowed: (url: string) => void; signal?: AbortSignal },
): Promise<void> {
	if (!Array.isArray(actions) || actions.length === 0) {
		throw new Error("actions must contain at least one Jev Browser action.");
	}
	if (actions.length > 50) {
		throw new Error("A single jev_actions call is limited to 50 actions.");
	}

	for (const action of actions) {
		assertActive(options.signal);
		switch (action.type) {
			case "click":
			case "double_click": {
				const modifiers = (action.keys ?? []).map(normalizeKey);
				const options = {
					button: normalizeButton(action.button),
					clickCount: action.type === "double_click" ? 2 : 1,
					modifiers,
				};
				await page.mouse.click(action.x, action.y, options);
				break;
			}
			case "scroll":
				if (typeof action.x === "number" && typeof action.y === "number") {
					await page.mouse.move(action.x, action.y);
				}
				await page.mouse.wheel(action.deltaX, action.deltaY);
				break;
			case "type":
				await page.keyboard.type(action.text);
				break;
			case "wait":
				await delay(
					Math.min(30_000, Math.max(0, action.ms ?? 1000)),
					options.signal,
				);
				break;
			case "keypress":
				await page.keyboard.press(action.keys.map(normalizeKey).join("+"));
				break;
			case "drag":
				await executeDrag(page, action.path, normalizeButton(action.button));
				break;
			case "move":
				await page.mouse.move(action.x, action.y);
				break;
			case "screenshot":
				break;
			case "navigate":
				options.assertUrlAllowed(action.url);
				await page.goto(action.url, {
					waitUntil: "domcontentloaded",
					timeout: 30_000,
				});
				break;
			case "back":
				await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
				break;
			case "forward":
				await page.goForward({
					waitUntil: "domcontentloaded",
					timeout: 30_000,
				});
				break;
			case "reload":
				await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
				break;
			default:
				throw new Error(
					`Unsupported Jev Browser action: ${String((action as { type?: unknown }).type)}`,
				);
		}
	}
}

export function normalizeKey(value: string): string {
	const key = value.trim();
	const lookup = key.toUpperCase();
	const aliases: Record<string, string> = {
		CTRL: "Control",
		CONTROL: "Control",
		CMD: "Meta",
		COMMAND: "Meta",
		META: "Meta",
		ALT: "Alt",
		OPTION: "Alt",
		SHIFT: "Shift",
		ENTER: "Enter",
		RETURN: "Enter",
		ESC: "Escape",
		ESCAPE: "Escape",
		SPACE: "Space",
		TAB: "Tab",
		BACKSPACE: "Backspace",
		DELETE: "Delete",
		DEL: "Delete",
		HOME: "Home",
		END: "End",
		PGUP: "PageUp",
		PAGEUP: "PageUp",
		PGDN: "PageDown",
		PAGEDOWN: "PageDown",
		UP: "ArrowUp",
		ARROWUP: "ArrowUp",
		DOWN: "ArrowDown",
		ARROWDOWN: "ArrowDown",
		LEFT: "ArrowLeft",
		ARROWLEFT: "ArrowLeft",
		RIGHT: "ArrowRight",
		ARROWRIGHT: "ArrowRight",
	};
	return aliases[lookup] ?? (key.length === 1 ? key : key);
}

function normalizeButton(value?: "left" | "right" | "wheel") {
	if (!value || value === "left") return "left" as const;
	if (value === "right") return "right" as const;
	if (value === "wheel") return "middle" as const;
	throw new Error(`Unsupported mouse button: ${String(value)}`);
}

async function executeDrag(
	page: Page,
	path: Array<{ x: number; y: number } | [number, number]>,
	button: "left" | "right" | "middle",
) {
	if (!Array.isArray(path) || path.length < 2) {
		throw new Error("drag requires a path with at least two points.");
	}
	const points = path.map((point) =>
		Array.isArray(point) ? { x: point[0], y: point[1] } : point,
	);
	await page.mouse.move(points[0].x, points[0].y);
	await page.mouse.down({ button });
	try {
		for (const point of points.slice(1)) {
			await page.mouse.move(point.x, point.y, { steps: 5 });
		}
	} finally {
		await page.mouse.up({ button });
	}
}

function assertActive(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("Browser action was aborted.");
}

async function delay(ms: number, signal?: AbortSignal) {
	await sleep(ms, undefined, { signal });
}
