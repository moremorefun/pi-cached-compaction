import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CachedCompactionConfig {
	/** "long" asks providers for their longer cache lifetime: 1 hour on Anthropic, 24 hours on OpenAI. */
	cacheRetention: "short" | "long";
	compactBeforeExpiry: boolean;
	minContextPercent: number;
}

const DEFAULTS: CachedCompactionConfig = { cacheRetention: "long", compactBeforeExpiry: false, minContextPercent: 50 };

function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), ".pi", "agent");
	return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

/** Reads the `cachedCompaction` key of the global Pi settings file. Invalid values fail loudly. */
export function loadConfig(): CachedCompactionConfig {
	const path = join(agentDir(), "settings.json");
	if (!existsSync(path)) return DEFAULTS;
	const raw: unknown = JSON.parse(readFileSync(path, "utf8")).cachedCompaction;
	if (raw === undefined) return DEFAULTS;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`cachedCompaction in ${path} must be an object`);
	const { cacheRetention = DEFAULTS.cacheRetention, compactBeforeExpiry = DEFAULTS.compactBeforeExpiry, minContextPercent = DEFAULTS.minContextPercent } =
		raw as Record<string, unknown>;
	if (cacheRetention !== "short" && cacheRetention !== "long") throw new Error(`cachedCompaction.cacheRetention in ${path} must be "short" or "long"`);
	if (typeof compactBeforeExpiry !== "boolean") throw new Error(`cachedCompaction.compactBeforeExpiry in ${path} must be true or false`);
	if (typeof minContextPercent !== "number" || !(minContextPercent >= 0 && minContextPercent <= 100)) {
		throw new Error(`cachedCompaction.minContextPercent in ${path} must be a number from 0 to 100`);
	}
	return { cacheRetention, compactBeforeExpiry, minContextPercent };
}
