import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeKey } from "../src/actions.ts";
import { isUrlAllowed, readConfig } from "../src/config.ts";

test("matches configured origins and blocks unsupported schemes", () => {
	const patterns = ["https://*.example.com", "http://localhost:*"];
	assert.equal(isUrlAllowed("https://app.example.com/path", patterns), true);
	assert.equal(isUrlAllowed("http://localhost:4173", patterns), true);
	assert.equal(isUrlAllowed("https://example.net", patterns), false);
	assert.equal(isUrlAllowed("file:///etc/passwd", ["*"]), false);
});

test("loads bounded config values", () => {
	const directory = mkdtempSync(join(tmpdir(), "jb-config-"));
	const path = join(directory, "config.json");
	try {
		writeFileSync(
			path,
			JSON.stringify({
				allowedOrigins: ["https://example.com"],
				viewport: { width: 99, height: 9999 },
				stream: { enabled: true, intervalMs: 10 },
			}),
		);
		const config = readConfig(path);
		assert.deepEqual(config.allowedOrigins, ["https://example.com"]);
		assert.deepEqual(config.viewport, { width: 640, height: 1600 });
		assert.deepEqual(config.stream, { enabled: true, intervalMs: 250 });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("uses complete defaults when configuration is omitted", () => {
	const config = readConfig(join(tmpdir(), "missing-jb.config.json"));
	assert.deepEqual(config.allowedOrigins, ["http://*", "https://*"]);
	assert.equal(config.headless, true);
	assert.equal(config.recordVideo, true);
	assert.equal(config.showCursor, true);
	assert.equal(config.showClickIndicators, true);
	assert.deepEqual(config.viewport, { width: 1280, height: 720 });
	assert.deepEqual(config.stream, { enabled: false, intervalMs: 1000 });
	assert.equal(config.outputDir, join(homedir(), ".jb", "data"));
	assert.equal(isUrlAllowed("https://openai.com", config.allowedOrigins), true);
	assert.equal(
		isUrlAllowed("http://example.test:8080", config.allowedOrigins),
		true,
	);
	assert.equal(
		isUrlAllowed("file:///etc/passwd", config.allowedOrigins),
		false,
	);
});

test("normalizes Jev Browser key aliases", () => {
	assert.equal(normalizeKey("CTRL"), "Control");
	assert.equal(normalizeKey("ARROWDOWN"), "ArrowDown");
	assert.equal(normalizeKey("a"), "a");
});
