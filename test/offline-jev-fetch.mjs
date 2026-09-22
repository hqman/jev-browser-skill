// Test-only fetch stand-in so a daemon subprocess can finish a run without a provider.
globalThis.fetch = async (_url, init) => {
	const body = JSON.parse(String(init?.body ?? "{}"));
	const questions = body.questions ?? {};
	const answers = Object.fromEntries(
		Object.entries(questions).map(([id, question]) => {
			const keys = Object.keys(question?.criteria ?? {});
			const choice = id === "action" ? "DONE" : keys[0];
			return [
				id,
				{
					type: "choice",
					choice,
					probabilities: Object.fromEntries(
						keys.map((key) => [key, key === choice ? 1 : 0]),
					),
				},
			];
		}),
	);
	return new Response(JSON.stringify({ answers }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
};
