import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

async function installChromium(): Promise<void> {
	// Resolve the installed plugin's CLI so browser revisions match its dependency.
	const cli = join(
		dirname(require.resolve("playwright/package.json")),
		"cli.js",
	);
	try {
		await execFileAsync(process.execPath, [cli, "install", "chromium"], {
			timeout: 120_000,
			maxBuffer: 2 * 1024 * 1024,
			windowsHide: true,
		});
	} catch {
		// Installer output can contain proxy credentials; do not expose it to tools.
		throw new Error(
			"Automatic Chromium setup failed or timed out. Check network/proxy access and browser-cache permissions, then retry jev_run. On Linux, required system libraries must also be installed by the system administrator.",
		);
	}
}

export function createBrowserSetup(install: () => Promise<void>) {
	let pending: Promise<void> | undefined;
	return () => {
		if (!pending) {
			pending = Promise.resolve()
				.then(install)
				.catch((error) => {
					pending = undefined;
					throw error;
				});
		}
		return pending;
	};
}

// The CLI checks its cache and downloads only missing browser artifacts.
export const ensureChromium = createBrowserSetup(installChromium);
