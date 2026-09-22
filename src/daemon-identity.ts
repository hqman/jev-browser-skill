import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function daemonConfigFingerprint(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const configPath = env.JB_CONFIG?.trim()
		? resolve(env.JB_CONFIG)
		: join(homedir(), ".jb", "config.json");
	const identity = {
		configPath,
		provider: env.JB_PROVIDER?.trim() ?? "",
		gatewayApiKey: env.AI_GATEWAY_API_KEY?.trim() ?? "",
		typesafeApiKey: env.TYPESAFE_API_KEY?.trim() ?? "",
		typesafeModel: env.TYPESAFE_MODEL?.trim() ?? "",
	};
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
