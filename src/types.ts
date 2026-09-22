import type { Browser, BrowserContext, Page, Video } from "playwright";

export interface JevBrowserConfig {
	allowedOrigins: string[];
	headless: boolean;
	recordVideo: boolean;
	showCursor: boolean;
	showClickIndicators: boolean;
	outputDir: string;
	viewport: { width: number; height: number };
	stream: { enabled: boolean; intervalMs: number };
}

export type BrowserAction =
	| {
			type: "click" | "double_click";
			x: number;
			y: number;
			button?: "left" | "right" | "wheel";
			keys?: string[];
	  }
	| { type: "scroll"; x?: number; y?: number; deltaX: number; deltaY: number }
	| { type: "type"; text: string }
	| { type: "wait"; ms?: number }
	| { type: "keypress"; keys: string[] }
	| {
			type: "drag";
			path: Array<{ x: number; y: number } | [number, number]>;
			button?: "left" | "right" | "wheel";
	  }
	| { type: "move"; x: number; y: number }
	| { type: "screenshot" }
	| { type: "navigate"; url: string }
	| { type: "back" | "forward" | "reload" };

export interface BrowserLogEntry {
	id: number;
	timestamp: string;
	type:
		| "console"
		| "pageerror"
		| "requestfailed"
		| "download"
		| "navigation"
		| "security";
	level: string;
	text: string;
	url?: string;
}

export interface BrowserState {
	active: boolean;
	currentUrl?: string;
	pageTitle?: string;
	pages: Array<{ index: number; title: string; url: string }>;
	startedAt?: string;
	viewport: { width: number; height: number };
}

export interface ActiveBrowserSession {
	browser: Browser;
	context: BrowserContext;
	page: Page;
	video?: Video;
	id: string;
	outputDir: string;
	startedAt: string;
	logs: BrowserLogEntry[];
	nextLogId: number;
	stream?: StreamController;
}

export interface StreamController {
	url: string;
	stop(): Promise<void>;
}

export interface ToolContext {
	sessionId?: string;
	// This context crosses JSON IPC. Live AbortSignals are not transported.
}
