import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { ActiveBrowserSession, StreamController } from "./types.ts";

export async function startStream(
	session: ActiveBrowserSession,
	options: { intervalMs: number },
): Promise<StreamController> {
	if (session.stream) return session.stream;

	const token = randomBytes(18).toString("base64url");
	const clients = new Set<ServerResponse>();
	let latestImage: Buffer | null = null;
	let capturing = false;
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const prefix = `/${token}`;
		if (!url.pathname.startsWith(prefix)) {
			response.writeHead(404).end("Not found");
			return;
		}

		if (url.pathname === `${prefix}/events`) {
			response.writeHead(200, {
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"content-type": "text/event-stream",
				"x-content-type-options": "nosniff",
			});
			clients.add(response);
			request.on("close", () => clients.delete(response));
			return;
		}

		if (url.pathname === `${prefix}/screenshot`) {
			if (!latestImage) {
				response.writeHead(503).end("Screenshot is not ready");
				return;
			}
			response.writeHead(200, {
				"cache-control": "no-store",
				"content-type": "image/png",
				"content-length": latestImage.byteLength,
				"x-content-type-options": "nosniff",
			});
			response.end(latestImage);
			return;
		}

		if (url.pathname === `${prefix}/logs`) {
			response.writeHead(200, {
				"cache-control": "no-store",
				"content-type": "application/json; charset=utf-8",
				"x-content-type-options": "nosniff",
			});
			response.end(JSON.stringify({ logs: session.logs.slice(-500) }));
			return;
		}

		if (url.pathname === prefix || url.pathname === `${prefix}/`) {
			response.writeHead(200, {
				"cache-control": "no-store",
				"content-security-policy":
					"default-src 'none'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
				"content-type": "text/html; charset=utf-8",
				"x-content-type-options": "nosniff",
			});
			response.end(viewerHtml(token));
			return;
		}

		response.writeHead(404).end("Not found");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Unable to bind stream server.");
	const url = `http://127.0.0.1:${address.port}/${token}/`;

	const capture = async () => {
		if (capturing || session.page.isClosed()) return;
		capturing = true;
		try {
			latestImage = await session.page.screenshot({ type: "png" });
			const payload = JSON.stringify({
				timestamp: new Date().toISOString(),
				url: session.page.url(),
				logs: session.logs.slice(-20),
			});
			for (const client of clients) client.write(`data: ${payload}\n\n`);
		} catch {
			// A close may race the periodic capture.
		} finally {
			capturing = false;
		}
	};
	await capture();
	const timer = setInterval(() => void capture(), options.intervalMs);

	const controller: StreamController = {
		url,
		async stop() {
			clearInterval(timer);
			for (const client of clients) client.end();
			clients.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
	session.stream = controller;
	return controller;
}

function viewerHtml(token: string) {
	return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Jev Browser</title><style>
html,body{margin:0;background:#09090b;color:#e4e4e7;font:14px system-ui;height:100%}main{display:grid;grid-template-rows:auto 1fr auto;height:100%}
header{padding:10px 14px;border-bottom:1px solid #27272a;display:flex;gap:12px}#url{color:#a1a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#screen{width:100%;height:100%;object-fit:contain;min-height:0}pre{height:120px;overflow:auto;margin:0;padding:10px 14px;border-top:1px solid #27272a;color:#a1a1aa;font:12px ui-monospace}
</style></head><body><main><header><strong>Live jb browser</strong><span id="url"></span></header>
<img id="screen" alt="Live browser screenshot"><pre id="logs"></pre></main><script>
const base='/${token}'; const image=document.querySelector('#screen'); const logs=document.querySelector('#logs'); const url=document.querySelector('#url');
new EventSource(base+'/events').onmessage=(event)=>{const data=JSON.parse(event.data);image.src=base+'/screenshot?t='+Date.now();url.textContent=data.url;logs.textContent=data.logs.map(x=>'['+x.level+'] '+x.text).join('\n');};
</script></body></html>`;
}
