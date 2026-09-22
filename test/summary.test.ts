import assert from "node:assert/strict";
import test from "node:test";
import { foundPage } from "../src/summary.ts";

test("foundPage reads url from screenshot state when top-level url is missing", () => {
	assert.deepEqual(
		foundPage({
			finalScreenshot: {
				artifactPath: "/tmp/final.png",
				state: {
					currentUrl: "https://github.com/hqman/JevScout",
					pageTitle: "GitHub - hqman/JevScout",
				},
			},
		}),
		{
			url: "https://github.com/hqman/JevScout",
			title: "GitHub - hqman/JevScout",
		},
	);
});

test("foundPage prefers top-level url and title", () => {
	assert.deepEqual(
		foundPage({
			url: "https://github.com/hqman/JevScout",
			title: "JevScout",
			finalScreenshot: {
				state: {
					currentUrl: "https://github.com/",
					pageTitle: "GitHub",
				},
			},
		}),
		{ url: "https://github.com/hqman/JevScout", title: "JevScout" },
	);
});
