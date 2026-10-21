import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { buildSessionProjection, convertToLlm, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

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
	// Pi stamps a custom message's entry when it saves it, which can be well after the message was sent.
	if (a.role === "custom" && b.role === "custom") return a.customType === b.customType && JSON.stringify(a.content) === JSON.stringify(b.content);
	if (a.role !== b.role || a.timestamp !== b.timestamp) return false;
	return a.role !== "toolResult" || b.role !== "toolResult" || a.toolCallId === b.toolCallId;
}

/** The model input a message or custom-message entry adds. Extensions send custom messages (subagent and intercom notices, for example). */
function entryMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") return sessionEntryToContextMessages(entry)[0];
	return undefined;
}

/**
 * Messages the branch gained after the captured request, or why the branch no longer extends
 * that request (navigation, edits, or entries that add model input).
 */
export function trailingMessages(entries: SessionEntry[], transcript: AgentMessage[]): { messages: AgentMessage[] } | { reason: string } {
	const last = transcript.findLast((message) => message.role !== "system");
	const index = !last
		? -1
		: last.role === "custom"
			// Pi saves a custom message when it delivers it, so its entry is the first matching one stamped no earlier than the message.
			? entries.findIndex((entry) => entry.type === "custom_message" && Date.parse(entry.timestamp) >= last.timestamp && sameMessage(sessionEntryToContextMessages(entry)[0], last))
			: entries.findLastIndex((entry) => entry.type === "message" && sameMessage(entry.message, last));
	if (index === -1) return { reason: "its last message is no longer on this branch" };
	const messages: AgentMessage[] = [];
	for (const entry of entries.slice(index + 1)) {
		const message = entryMessage(entry);
		if (message) messages.push(message);
		// Compaction during a run appends its entry after messages the next request carries behind the new summary.
		else if (entry.type === "compaction" && transcript.some((message) => message.role === "compactionSummary" && message.timestamp === Date.parse(entry.timestamp))) continue;
		else if (!CONTEXT_FREE_ENTRY_TYPES.has(entry.type)) return { reason: `a ${entry.type} entry came after it` };
	}
	return { messages };
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

export function formatTokens(count: number): string {
	return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

function canonical(value: unknown): string {
	// Pi moves the cache breakpoint to the newest message on every request; it is not part of the cached content.
	return JSON.stringify(value, (key, field) => (key === "cache_control" ? undefined : field)) ?? "undefined";
}

export interface PrefixMismatch {
	reason: string;
	/** Both serialized values from just before their first differing character, so the log shows what changed. */
	captured?: string;
	rebuilt?: string;
}

function difference(reason: string, captured: string, rebuilt: string): PrefixMismatch {
	let at = 0;
	while (at < captured.length && captured[at] === rebuilt[at]) at++;
	const from = Math.max(0, at - 40);
	return { reason, captured: captured.slice(from, at + 160), rebuilt: rebuilt.slice(from, at + 160) };
}

/**
 * Where `rebuilt` stops matching the cache entry `captured` wrote, or undefined when it extends that request exactly.
 * `cacheNeutral` names top-level fields the provider keeps out of the cached prefix.
 */
export function prefixMismatch(captured: Payload, rebuilt: Payload, key: string, cacheNeutral: ReadonlySet<string> = new Set()): PrefixMismatch | undefined {
	for (const field of new Set([...Object.keys(captured), ...Object.keys(rebuilt)])) {
		if (field === key || OUTPUT_LIMIT_KEYS.has(field) || cacheNeutral.has(field)) continue;
		const [before, after] = [canonical(captured[field]), canonical(rebuilt[field])];
		if (before !== after) return difference(`request field "${field}" differs`, before, after);
	}
	const before = captured[key] as unknown[];
	const after = rebuilt[key];
	if (!Array.isArray(after)) return { reason: `request has no "${key}" array` };
	let end = before.length;
	// The active effort rides at the end, after the cache breakpoint: Anthropic as trailing system entries,
	// OpenAI as a trailing configuration_update item. The next request moves it after the new turns.
	while (end > 0 && isTrailingEffort(before[end - 1])) end--;
	if (after.length <= end) return { reason: "request is shorter than the cached one" };
	for (let index = 0; index < end; index++) {
		const [was, now] = [canonical(before[index]), canonical(after[index])];
		if (was !== now) return difference(`message ${index} differs`, was, now);
	}
	return undefined;
}

function isTrailingEffort(item: unknown): boolean {
	return isPayload(item) && (item.role === "system" || item.type === "configuration_update");
}

/**
 * `rebuilt` plus the top-level fields only `captured` has. Extensions earlier in the before_provider_request
 * chain add fields to the agent's requests (codex-fast adds service_tier), and the summary request skips that chain.
 */
export function withCapturedFields(captured: Payload, rebuilt: Payload): Payload {
	const missing = Object.keys(captured).filter((field) => !(field in rebuilt));
	return missing.length === 0 ? rebuilt : { ...rebuilt, ...Object.fromEntries(missing.map((field) => [field, captured[field]])) };
}

/**
 * OpenAI's mixed cache lifetimes for GPT-5.6 and later: the system prompt, with the tool definitions
 * rendered before it, gets a 12-hour breakpoint, and the conversation keeps the 30-minute default.
 * `cacheKey` replaces Pi's per-session key, which keeps every new session from reading that prefix.
 * Only requests Pi already sends cache options are changed: Pi drops them when caching is off and on
 * endpoints that reject them, such as Sign in with ChatGPT.
 */
export function withSharedPrefixCache(payload: Payload, cacheKey: string): Payload {
	const input = payload.input;
	if (typeof payload.prompt_cache_key !== "string" || !isPayload(payload.prompt_cache_options) || !Array.isArray(input)) return payload;
	const [first, ...rest] = input;
	if (!isPayload(first) || first.role !== "developer" || typeof first.content !== "string") return payload;
	const content = [{ type: "input_text", text: first.content, prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } }];
	return { ...payload, prompt_cache_key: cacheKey, input: [{ ...first, content }, ...rest] };
}

function contentText(content: string | { type: string; text?: string }[]): string {
	return typeof content === "string" ? content : content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

/** First words of a message as the model reads it, so the summary prompt can point at where the kept context starts. */
function messagePreview(message: Message): string | undefined {
	let text: string | undefined;
	if (message.role === "user") {
		text = contentText(message.content);
	} else if (message.role === "assistant") {
		text = message.content
			.flatMap((block) => (block.type === "text" ? [block.text] : block.type === "toolCall" ? [`[tool call: ${block.name} ${JSON.stringify(block.arguments)}]`] : []))
			.join("\n");
	}
	text = text?.trim();
	if (!text) return undefined;
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export interface KeptStart {
	text: string;
	/** Which of the kept messages opening with `text` it is, counting back from the end (1 for the last). */
	fromEnd: number;
}

/**
 * Where the messages Pi keeps verbatim start in `conversation`, the messages the summary request sends: the opening
 * of the first kept message it carries, as the model reads it. Undefined when there is none, or it has no text to
 * quote (an image or thinking only). Pi's cut can land on metadata entries just before that message, such as a
 * thinking change, and the request can lack kept messages that context handlers or `!!` commands keep from the model.
 */
export function keptStart(entries: SessionEntry[], firstKeptEntryId: string, conversation: AgentMessage[]): KeptStart | undefined {
	const projected = buildSessionProjection(entries).entries;
	const start = projected.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
	if (start === -1) return undefined;
	const sent = conversation.filter((message) => convertToLlm([message]).length > 0);
	let at = -1;
	for (const message of projected.slice(start).flatMap((entry) => entry.messages)) {
		// The last match: a repeated custom message matched too early would leave messages unsummarized.
		at = sent.findLastIndex((candidate) => sameMessage(candidate, message));
		if (at !== -1) break;
	}
	if (at === -1) return undefined;
	const previews = convertToLlm(sent.slice(at)).map(messagePreview);
	const text = previews[0];
	return text ? { text, fromEnd: previews.filter((preview) => preview === text).length } : undefined;
}

export function summaryInstruction(kept: KeptStart, customInstructions: string | undefined): string {
	const repeated = kept.fromEnd > 1 ? ` Several kept messages begin with this text: it is number ${kept.fromEnd} of them, counting back from the end.` : "";
	const toolCalls = kept.text.includes("[tool call: ") ? " Tool calls are written as [tool call: name arguments]." : "";
	const focus = customInstructions?.trim() ? `\n\nAdditional focus: ${customInstructions.trim()}` : "";
	return `Stop working on the task and do not call any tools. Write a structured context checkpoint summary of the conversation above. Another LLM will use it to continue the work after the earlier messages are removed.

Everything from the message that begins with the text below onward stays in context verbatim, placed right after your summary.${repeated}${toolCalls} Summarize only what comes before that message, and describe the state as of that point. Do not report anything from the kept messages as done or decided: the next model reads them itself, after your summary.

<kept-start>
${kept.text}
</kept-start>

If the conversation starts with an earlier summary, fold it into the new one: keep its facts, move finished items to Done, and update Next Steps.

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
