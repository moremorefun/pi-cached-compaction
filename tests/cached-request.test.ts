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

test("a branch that no longer contains the captured transcript is rejected", () => {
	assert.equal(trailingMessages([entry("a", user("other branch", 5))], [user("fix the bug", 1)]), undefined);
	const withSummary = [
		entry("a", user("fix the bug", 1)),
		{ type: "branch_summary", id: "s", parentId: "a", timestamp: "", summary: "...", fromId: "x" } as SessionEntry,
	];
	assert.equal(trailingMessages(withSummary, [user("fix the bug", 1)]), undefined);
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
