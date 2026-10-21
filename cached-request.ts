import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Entry types that never add model input, so they may sit between the captured request and compaction. */
const CONTEXT_FREE_ENTRY_TYPES = new Set(["custom", "label", "session_info", "usage", "thinking_level_change"]);
const MESSAGE_ARRAY_KEYS = ["messages", "input"] as const;
const OUTPUT_LIMIT_KEYS = new Set(["max_tokens", "max_output_tokens", "max_completion_tokens"]);

type Payload = Record<string, unknown>;

export function isPayload(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The payload field that carries the conversation, for the provider APIs this extension supports. */
export function messageArrayKey(payload: Payload): string | undefined {
	return MESSAGE_ARRAY_KEYS.find((key) => Array.isArray(payload[key]));
}

function sameMessage(a: AgentMessage, b: AgentMessage): boolean {
	if (a.role !== b.role || a.timestamp !== b.timestamp) return false;
	return a.role !== "toolResult" || b.role !== "toolResult" || a.toolCallId === b.toolCallId;
}

/**
 * Messages the branch gained after the captured request, or undefined when the branch
 * no longer extends that request (navigation, edits, or entries that add model input).
 */
export function trailingMessages(entries: SessionEntry[], transcript: AgentMessage[]): AgentMessage[] | undefined {
	const last = transcript.findLast((message) => message.role !== "system");
	if (!last) return undefined;
	const index = entries.findLastIndex((entry) => entry.type === "message" && sameMessage(entry.message, last));
	if (index === -1) return undefined;
	const trailing: AgentMessage[] = [];
	for (const entry of entries.slice(index + 1)) {
		if (entry.type === "message") trailing.push(entry.message);
		else if (!CONTEXT_FREE_ENTRY_TYPES.has(entry.type)) return undefined;
	}
	return trailing;
}

/**
 * When the prompt cache written by the branch's latest request expires, or undefined when no
 * request since the last compaction used the cache. Pi's cache warmer records each refresh as a usage entry.
 */
export function cacheExpiresAt(entries: SessionEntry[], ttlMs: number): number | undefined {
	let refreshedAt: number | undefined;
	for (const entry of entries) {
		if (entry.type === "compaction") {
			refreshedAt = undefined;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			// A failed request may never have reached the cache, so it neither refreshes nor clears it.
			if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
			const { cacheRead, cacheWrite } = entry.message.usage;
			refreshedAt = cacheRead + cacheWrite > 0 ? entry.message.timestamp : undefined;
		} else if (entry.type === "usage" && entry.kind === "cache_warm" && refreshedAt !== undefined) {
			refreshedAt = Math.max(refreshedAt, Date.parse(entry.timestamp));
		}
	}
	return refreshedAt === undefined ? undefined : refreshedAt + ttlMs;
}

/**
 * The cache tier the branch's latest cache write used, as the provider reported it: Pi's
 * Anthropic provider and the Claude bridge give the 1-hour share of a write as `cacheWrite1h`.
 * Undefined when no write since the last compaction reports it.
 */
export function reportedCacheTier(entries: SessionEntry[]): "short" | "long" | undefined {
	let tier: "short" | "long" | undefined;
	for (const entry of entries) {
		if (entry.type === "compaction") {
			tier = undefined;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const { cacheWrite, cacheWrite1h } = entry.message.usage;
			if (cacheWrite > 0 && cacheWrite1h !== undefined) tier = cacheWrite1h > 0 ? "long" : "short";
		}
	}
	return tier;
}

export function formatRemaining(ms: number): string {
	if (ms <= 0) return "cache cold";
	const seconds = Math.ceil(ms / 1000);
	if (seconds >= 120) return `⏱ ${Math.floor(seconds / 60)}m`;
	return `⏱ ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function canonical(value: unknown): string {
	// Pi moves the cache breakpoint to the newest message on every request; it is not part of the cached content.
	return JSON.stringify(value, (key, field) => (key === "cache_control" ? undefined : field)) ?? "undefined";
}

/**
 * Why `rebuilt` cannot read the cache entry `captured` wrote, or undefined when it extends that request exactly.
 * `cacheNeutral` names top-level fields the provider keeps out of the cached prefix.
 */
export function prefixMismatch(captured: Payload, rebuilt: Payload, key: string, cacheNeutral: ReadonlySet<string> = new Set()): string | undefined {
	for (const field of new Set([...Object.keys(captured), ...Object.keys(rebuilt)])) {
		if (field === key || OUTPUT_LIMIT_KEYS.has(field) || cacheNeutral.has(field)) continue;
		if (canonical(captured[field]) !== canonical(rebuilt[field])) return `request field "${field}" differs`;
	}
	const before = captured[key] as unknown[];
	const after = rebuilt[key];
	if (!Array.isArray(after)) return `request has no "${key}" array`;
	let end = before.length;
	// The active effort rides at the end, after the cache breakpoint: Anthropic as trailing system entries,
	// OpenAI as a trailing configuration_update item. The next request moves it after the new turns.
	while (end > 0 && isTrailingEffort(before[end - 1])) end--;
	if (after.length <= end) return "request is shorter than the cached one";
	for (let index = 0; index < end; index++) {
		if (canonical(before[index]) !== canonical(after[index])) return `message ${index} differs`;
	}
	return undefined;
}

function isTrailingEffort(item: unknown): boolean {
	return isPayload(item) && (item.role === "system" || item.type === "configuration_update");
}

function contentText(content: string | { type: string; text?: string }[]): string {
	return typeof content === "string" ? content : content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

/** First words of the entry Pi keeps first, so the summary prompt can point at where the kept context starts. */
export function entryPreview(entry: SessionEntry): string | undefined {
	let text: string | undefined;
	if (entry.type === "custom_message") {
		text = contentText(entry.content);
	} else if (entry.type === "branch_summary") {
		text = entry.summary;
	} else if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "user") {
			text = contentText(message.content);
		} else if (message.role === "assistant") {
			text = message.content
				.flatMap((block) => (block.type === "text" ? [block.text] : block.type === "toolCall" ? [`[tool call: ${block.name}]`] : []))
				.join("\n");
		} else if (message.role === "bashExecution") {
			text = `$ ${message.command}`;
		}
	}
	text = text?.trim();
	if (!text) return undefined;
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export function summaryInstruction(keptStart: string | undefined, customInstructions: string | undefined): string {
	const kept = keptStart
		? `Everything from the message that begins with the text below onward stays in context verbatim, placed right after your summary. Summarize only what comes before that message, and describe the state as of that point. Do not report anything from the kept messages as done or decided: the next model reads them itself, after your summary.

<kept-start>
${keptStart}
</kept-start>

`
		: "";
	const focus = customInstructions?.trim() ? `\n\nAdditional focus: ${customInstructions.trim()}` : "";
	return `Stop working on the task and do not call any tools. Write a structured context checkpoint summary of the conversation above. Another LLM will use it to continue the work after the earlier messages are removed.

${kept}If the conversation starts with an earlier summary, fold it into the new one: keep its facts, move finished items to Done, and update Next Steps.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages. Reply with the summary only.${focus}`;
}
