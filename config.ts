import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface CachedCompactionConfig {
	/** "long" asks providers for their longer cache lifetime in interactive sessions: 1 hour on Anthropic, 24 hours on OpenAI. */
	cacheRetention: "short" | "long";
	compactBeforeExpiry: boolean;
	minContextTokens: number;
}

const DEFAULTS: CachedCompactionConfig = { cacheRetention: "long", compactBeforeExpiry: false, minContextTokens: 50_000 };

/** Reads the `cachedCompaction` key of the global Pi settings file. Invalid values fail loudly. */
export function loadConfig(): CachedCompactionConfig {
	const path = join(getAgentDir(), "settings.json");
	if (!existsSync(path)) return DEFAULTS;
	const raw: unknown = JSON.parse(readFileSync(path, "utf8")).cachedCompaction;
	if (raw === undefined) return DEFAULTS;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`cachedCompaction in ${path} must be an object`);
	const { cacheRetention = DEFAULTS.cacheRetention, compactBeforeExpiry = DEFAULTS.compactBeforeExpiry, minContextTokens = DEFAULTS.minContextTokens } =
		raw as Record<string, unknown>;
	if (cacheRetention !== "short" && cacheRetention !== "long") throw new Error(`cachedCompaction.cacheRetention in ${path} must be "short" or "long"`);
	if (typeof compactBeforeExpiry !== "boolean") throw new Error(`cachedCompaction.compactBeforeExpiry in ${path} must be true or false`);
	if (typeof minContextTokens !== "number" || !Number.isInteger(minContextTokens) || minContextTokens < 0) {
		throw new Error(`cachedCompaction.minContextTokens in ${path} must be a whole number of tokens`);
	}
	return { cacheRetention, compactBeforeExpiry, minContextTokens };
}
