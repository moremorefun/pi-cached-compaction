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

function canonical(value: unknown): string {
	// Pi moves the cache breakpoint to the newest message on every request; it is not part of the cached content.
	return JSON.stringify(value, (key, field) => (key === "cache_control" ? undefined : field)) ?? "undefined";
}

/** Why `rebuilt` cannot read the cache entry `captured` wrote, or undefined when it extends that request exactly. */
export function prefixMismatch(captured: Payload, rebuilt: Payload, key: string): string | undefined {
	for (const field of new Set([...Object.keys(captured), ...Object.keys(rebuilt)])) {
		if (field === key || OUTPUT_LIMIT_KEYS.has(field)) continue;
		if (canonical(captured[field]) !== canonical(rebuilt[field])) return `request field "${field}" differs`;
	}
	const before = captured[key] as unknown[];
	const after = rebuilt[key];
	if (!Array.isArray(after)) return `request has no "${key}" array`;
	let end = before.length;
	// Anthropic sends the active effort as trailing system entries; the next request moves them after the new turns.
	while (end > 0 && isPayload(before[end - 1]) && (before[end - 1] as Payload).role === "system") end--;
	if (after.length <= end) return "request is shorter than the cached one";
	for (let index = 0; index < end; index++) {
		if (canonical(before[index]) !== canonical(after[index])) return `message ${index} differs`;
	}
	return undefined;
}

/** First words of a message, so the summary prompt can point at where the kept context starts. */
export function messagePreview(message: AgentMessage): string | undefined {
	let text: string | undefined;
	if (message.role === "user") {
		text = typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	} else if (message.role === "assistant") {
		text = message.content
			.flatMap((block) => (block.type === "text" ? [block.text] : block.type === "toolCall" ? [`[tool call: ${block.name}]`] : []))
			.join("\n");
	} else if (message.role === "bashExecution") {
		text = `$ ${message.command}`;
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
