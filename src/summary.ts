export function foundPage(data: unknown): { url?: string; title?: string } {
	if (!data || typeof data !== "object") return {};
	const d = data as Record<string, unknown>;
	const shot =
		d.finalScreenshot && typeof d.finalScreenshot === "object"
			? (d.finalScreenshot as Record<string, unknown>)
			: undefined;
	const state =
		shot?.state && typeof shot.state === "object"
			? (shot.state as Record<string, unknown>)
			: undefined;
	return {
		url: text(d.url) ?? text(state?.currentUrl),
		title: text(d.title) ?? text(state?.pageTitle),
	};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
