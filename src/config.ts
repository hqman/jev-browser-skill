import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { JevBrowserConfig } from "./types.ts";

export const CONFIG_PATH =
	process.env.JB_CONFIG?.trim() || join(homedir(), ".jb", "config.json");

const DEFAULT_CONFIG: JevBrowserConfig = {
	allowedOrigins: ["http://*", "https://*"],
	headless: true,
	recordVideo: true,
	showCursor: true,
	showClickIndicators: true,
	outputDir: join(homedir(), ".jb", "data"),
	viewport: { width: 1280, height: 720 },
	stream: { enabled: false, intervalMs: 1000 },
};

export function readConfigFile(path = CONFIG_PATH): Record<string, unknown> {
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Error("Invalid configuration");
		return raw as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(
			"Cannot read ~/.jb/config.json. Check permissions and JSON syntax.",
		);
	}
}

export function readConfig(path = CONFIG_PATH): JevBrowserConfig {
	// Only browser settings leave this reader; credentials stay out of browser state.
	const raw = readConfigFile(path) as Partial<JevBrowserConfig>;

	const viewport = {
		width: boundedInteger(
			raw.viewport?.width,
			640,
			2560,
			DEFAULT_CONFIG.viewport.width,
		),
		height: boundedInteger(
			raw.viewport?.height,
			480,
			1600,
			DEFAULT_CONFIG.viewport.height,
		),
	};
	const allowedOrigins = Array.isArray(raw.allowedOrigins)
		? raw.allowedOrigins.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			)
		: DEFAULT_CONFIG.allowedOrigins;

	return {
		allowedOrigins,
		headless: raw.headless !== false,
		recordVideo: raw.recordVideo !== false,
		showCursor: raw.showCursor !== false,
		showClickIndicators: raw.showClickIndicators !== false,
		outputDir:
			typeof raw.outputDir === "string" && raw.outputDir.trim()
				? resolve(raw.outputDir.replace(/^~/, homedir()))
				: DEFAULT_CONFIG.outputDir,
		viewport,
		stream: {
			enabled: raw.stream?.enabled === true,
			intervalMs: boundedInteger(
				raw.stream?.intervalMs,
				250,
				10_000,
				DEFAULT_CONFIG.stream.intervalMs,
			),
		},
	};
}

export function isUrlAllowed(value: string, patterns: string[]): boolean {
	if (value === "about:blank") return true;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;

	return patterns.some((pattern) => {
		const normalized = pattern.trim();
		if (!normalized) return false;
		const expression = `^${escapeRegExp(normalized).replaceAll("\\*", ".*")}$`;
		return new RegExp(expression, "i").test(url.origin);
	});
}

function boundedInteger(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
) {
	return typeof value === "number" && Number.isInteger(value)
		? Math.min(max, Math.max(min, value))
		: fallback;
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
