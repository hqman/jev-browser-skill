import type { BrowserContext } from "playwright";

export async function installRecordingOverlay(
	context: BrowserContext,
	options: { showCursor: boolean; showClickIndicators: boolean },
) {
	if (!options.showCursor && !options.showClickIndicators) return;

	await context.addInitScript(({ showCursor, showClickIndicators }) => {
		const cursorId = "__jb-browser-cursor";
		const markerAttribute = "data-jb-browser-overlay";
		let cursor: HTMLDivElement | null = null;

		const applyBaseStyle = (element: HTMLElement) => {
			element.setAttribute(markerAttribute, "true");
			element.style.position = "fixed";
			element.style.pointerEvents = "none";
			element.style.zIndex = "2147483647";
			element.style.boxSizing = "border-box";
		};

		const ensureCursor = () => {
			if (!showCursor || cursor?.isConnected || !document.documentElement)
				return;
			cursor = document.createElement("div");
			cursor.id = cursorId;
			applyBaseStyle(cursor);
			cursor.style.width = "14px";
			cursor.style.height = "14px";
			cursor.style.border = "2px solid #ffffff";
			cursor.style.borderRadius = "50%";
			cursor.style.background = "#2563eb";
			cursor.style.boxShadow = "0 0 0 1px #111827, 0 1px 4px rgba(0,0,0,.65)";
			cursor.style.transform = "translate(-7px, -7px)";
			cursor.style.display = "none";
			document.documentElement.appendChild(cursor);
		};

		const placeCursor = (x: number, y: number) => {
			ensureCursor();
			if (!cursor) return;
			cursor.style.left = `${x}px`;
			cursor.style.top = `${y}px`;
			cursor.style.display = "block";
		};

		window.addEventListener(
			"mousemove",
			(event) => placeCursor(event.clientX, event.clientY),
			true,
		);
		window.addEventListener(
			"mousedown",
			(event) => {
				placeCursor(event.clientX, event.clientY);
				if (!showClickIndicators || !document.documentElement) return;
				const ring = document.createElement("div");
				applyBaseStyle(ring);
				ring.style.left = `${event.clientX}px`;
				ring.style.top = `${event.clientY}px`;
				ring.style.width = "38px";
				ring.style.height = "38px";
				ring.style.border = "4px solid #ef4444";
				ring.style.borderRadius = "50%";
				ring.style.transform = "translate(-19px, -19px) scale(.35)";
				ring.style.opacity = "1";
				document.documentElement.appendChild(ring);
				const animation = ring.animate(
					[
						{ opacity: 1, transform: "translate(-19px, -19px) scale(.35)" },
						{ opacity: 0, transform: "translate(-19px, -19px) scale(1.35)" },
					],
					{ duration: 650, easing: "ease-out" },
				);
				animation.addEventListener("finish", () => ring.remove(), {
					once: true,
				});
			},
			true,
		);
	}, options);
}
