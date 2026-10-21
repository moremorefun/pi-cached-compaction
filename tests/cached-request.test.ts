import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cacheExpiresAt, prefixMismatch, reportedCacheTier, trailingMessages } from "../cached-request.ts";

const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp }) as AgentMessage;
const entry = (id: string, message: AgentMessage) => ({ type: "message", id, parentId: null, timestamp: "", message }) as SessionEntry;

test("a request that only appends turns and moves the cache breakpoint matches", () => {
	const captured = {
		model: "m",
		system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
		max_tokens: 100,
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
			{ role: "system", content: [], output_config: { effort: "high" } },
		],
	};
	const rebuilt = {
		...captured,
		max_tokens: 90,
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			{ role: "user", content: [{ type: "text", text: "summarize", cache_control: { type: "ephemeral" } }] },
		],
	};
	assert.equal(prefixMismatch(captured, rebuilt, "messages"), undefined);
});

test("a changed prefix or request field is reported", () => {
	const captured = { model: "m", messages: [{ role: "user", content: "hi" }] };
	assert.equal(
		prefixMismatch(captured, { model: "m", messages: [{ role: "user", content: "edited" }, { role: "user", content: "x" }] }, "messages"),
		"message 0 differs",
	);
	assert.equal(
		prefixMismatch(captured, { model: "other", messages: [...captured.messages, { role: "user", content: "x" }] }, "messages"),
		'request field "model" differs',
	);
});

test("trailing messages are the branch entries after the captured transcript", () => {
	const prompt = user("fix the bug", 1);
	const reply = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } as AgentMessage;
	const entries = [
		entry("a", prompt),
		{ type: "label", id: "l", parentId: "a", timestamp: "", targetId: "a", label: "x" } as SessionEntry,
		entry("b", reply),
	];
	assert.deepEqual(trailingMessages(entries, [prompt]), [reply]);
});

test("a field the provider keeps out of the cached prefix may differ only when named", () => {
	const captured = { model: "gpt", tool_choice: "auto", input: [{ role: "user", content: "hi" }] };
	const rebuilt = { ...captured, tool_choice: "none", input: [...captured.input, { role: "user", content: "summarize" }] };
	assert.equal(prefixMismatch(captured, rebuilt, "input"), 'request field "tool_choice" differs');
	assert.equal(prefixMismatch(captured, rebuilt, "input", new Set(["tool_choice"])), undefined);
	// OpenAI's active reasoning effort trails the cache breakpoint and moves after the new turns.
	const withEffort = { ...captured, input: [...captured.input, { type: "configuration_update", reasoning: { effort: "high" } }] };
	assert.equal(prefixMismatch(withEffort, rebuilt, "input", new Set(["tool_choice"])), undefined);
});

test("a branch that no longer contains the captured transcript is rejected", () => {
	assert.equal(trailingMessages([entry("a", user("other branch", 5))], [user("fix the bug", 1)]), undefined);
	const withSummary = [
		entry("a", user("fix the bug", 1)),
		{ type: "branch_summary", id: "s", parentId: "a", timestamp: "", summary: "...", fromId: "x" } as SessionEntry,
	];
	assert.equal(trailingMessages(withSummary, [user("fix the bug", 1)]), undefined);
});

test("a compaction entry the captured request already summarizes does not end the trailing messages", () => {
	// Mid-run compaction: the entry lands after the tool result, and the next request starts with its summary.
	const toolResult = user("tool output", 2);
	const call = { role: "assistant", content: [{ type: "text", text: "edit" }], timestamp: 4 } as AgentMessage;
	const compaction = (at: number) => ({ type: "compaction", id: `c${at}`, parentId: null, timestamp: new Date(at).toISOString(), summary: "s", firstKeptEntryId: "a", tokensBefore: 1 }) as SessionEntry;
	const entries = [entry("a", user("fix the bug", 1)), entry("b", toolResult), compaction(3), entry("d", call)];
	const summary = { role: "compactionSummary", summary: "s", tokensBefore: 1, timestamp: 3 } as AgentMessage;
	assert.deepEqual(trailingMessages(entries, [summary, user("fix the bug", 1), toolResult]), [call]);
	// A request sent before that compaction does not carry its summary.
	assert.equal(trailingMessages(entries, [user("fix the bug", 1), toolResult]), undefined);
});

test("cache expiry follows the latest cached request and cache-warming refreshes, and resets at compaction", () => {
	const assistant = (timestamp: number, cacheRead: number) =>
		({ role: "assistant", content: [], timestamp, usage: { input: 1, output: 1, cacheRead, cacheWrite: 0 } }) as unknown as AgentMessage;
	const warm = (at: number) => ({ type: "usage", id: `w${at}`, parentId: null, timestamp: new Date(at).toISOString(), kind: "cache_warm" }) as SessionEntry;
	const compaction = { type: "compaction", id: "c", parentId: null, timestamp: "" } as SessionEntry;

	assert.equal(cacheExpiresAt([entry("a", assistant(1_000, 500))], 300_000), 301_000);
	assert.equal(cacheExpiresAt([entry("a", assistant(1_000, 500)), warm(200_000)], 300_000), 500_000);
	assert.equal(cacheExpiresAt([entry("a", assistant(1_000, 0))], 300_000), undefined);
	const failed = { ...assistant(9_000, 0), stopReason: "error" } as AgentMessage;
	assert.equal(cacheExpiresAt([entry("a", assistant(1_000, 500)), entry("b", failed)], 300_000), 301_000);
	assert.equal(cacheExpiresAt([entry("a", assistant(1_000, 500)), compaction], 300_000), undefined);
});

test("the cache tier comes from the latest write that reports its 1-hour share", () => {
	const wrote = (id: string, cacheWrite: number, cacheWrite1h?: number) =>
		entry(id, { role: "assistant", content: [], timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite, ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }) } } as unknown as AgentMessage);
	const compaction = { type: "compaction", id: "c", parentId: null, timestamp: "" } as SessionEntry;

	assert.equal(reportedCacheTier([wrote("a", 500, 500)]), "long");
	assert.equal(reportedCacheTier([wrote("a", 500, 500), wrote("b", 40, 0)]), "short");
	assert.equal(reportedCacheTier([wrote("a", 500, 500), wrote("b", 0, 0)]), "long", "a turn that only read keeps the tier");
	assert.equal(reportedCacheTier([wrote("a", 500)]), undefined, "a provider that does not report the share gives no tier");
	assert.equal(reportedCacheTier([wrote("a", 500, 500), compaction]), undefined);
});
