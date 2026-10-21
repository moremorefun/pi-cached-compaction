import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { convertToLlm, getLatestCompactionEntry, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPayload, messageArrayKey, messagePreview, prefixMismatch, summaryInstruction, trailingMessages } from "./cached-request.ts";

interface CapturedRequest {
	transcript: AgentMessage[];
	payload: Record<string, unknown>;
	model: Model<Api>;
	sentAt: number;
}

const PREFIX_MISMATCH = "pi-cached-compaction: request prefix differs from the cached request";

function formatTokens(count: number): string {
	return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

export default function cachedCompaction(pi: ExtensionAPI) {
	let pendingTranscript: AgentMessage[] | undefined;
	let captured: CapturedRequest | undefined;
	const forget = () => {
		pendingTranscript = undefined;
		captured = undefined;
	};

	// context_with_system fires only for main-agent LLM calls, right before their payload.
	// Cache-warming replays and other extensions' one-off calls send a payload without it.
	pi.on("context_with_system", (event) => {
		pendingTranscript = [...event.messages];
	});
	pi.on("before_provider_request", (event, ctx) => {
		const transcript = pendingTranscript;
		pendingTranscript = undefined;
		if (!transcript || !ctx.model || !isPayload(event.payload)) return;
		captured = { transcript, payload: event.payload, model: ctx.model, sentAt: Date.now() };
	});
	pi.on("message_start", () => {
		pendingTranscript = undefined;
	});
	pi.on("session_compact", forget);
	pi.on("session_tree", forget);
	pi.on("model_select", forget);

	pi.on("session_before_compact", async (event, ctx) => {
		const fallBack = (reason: string) => {
			if (ctx.hasUI) ctx.ui.notify(`Cached compaction skipped (${reason}). Using Pi's default compaction.`, "info");
			return undefined;
		};
		const request = captured;
		if (!request) return undefined;
		if (event.reason === "overflow") return fallBack("the last request overflowed the context window");
		if (ctx.model?.provider !== request.model.provider || ctx.model.id !== request.model.id) {
			return fallBack("the model changed since the last request");
		}
		const key = messageArrayKey(request.payload);
		if (!key) return fallBack(`${request.model.api} requests are not supported`);
		const trailing = trailingMessages(event.branchEntries, request.transcript);
		if (!trailing) return fallBack("the conversation changed since the last request");
		// A cold cache makes the full prompt cost more than Pi's default, which sends only the summarized messages.
		const ttlSeconds = request.model.promptCache?.[process.env.PI_CACHE_RETENTION === "long" ? "long" : "short"];
		if (ttlSeconds !== undefined) {
			// Pi's cache warmer re-sends the same prefix before expiry and records each refresh as a usage entry.
			const refreshedAt = Math.max(
				request.sentAt,
				...event.branchEntries.flatMap((entry) => (entry.type === "usage" && entry.kind === "cache_warm" ? [Date.parse(entry.timestamp)] : [])),
			);
			if (Date.now() - refreshedAt > ttlSeconds * 1000) return fallBack("the prompt cache has expired");
		}

		const { preparation } = event;
		const keptEntry = event.branchEntries.find((entry) => entry.id === preparation.firstKeptEntryId);
		const keptStart = keptEntry?.type === "message" ? messagePreview(keptEntry.message) : undefined;
		const instruction: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: summaryInstruction(keptStart, event.customInstructions) }],
			timestamp: Date.now(),
		};

		// Same model, thinking level, and session id as the agent, so Pi serializes the same prefix.
		// onPayload proves it against the captured request before anything is sent.
		let mismatch: string | undefined;
		const thinkingLevel = pi.getThinkingLevel();
		const response = await ctx.modelRegistry
			.streamSimple(request.model, { messages: convertToLlm([...request.transcript, ...trailing, instruction]) }, {
				reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
				sessionId: ctx.sessionManager.getSessionId(),
				signal: event.signal,
				onPayload: (params) => {
					mismatch = isPayload(params) ? prefixMismatch(request.payload, params, key) : "the provider payload is not an object";
					if (mismatch) throw new Error(PREFIX_MISMATCH);
					return undefined;
				},
			})
			.result();

		if (response.stopReason === "aborted") return { cancel: true };
		if (mismatch) return fallBack(mismatch);
		if (response.stopReason === "error") return fallBack(response.errorMessage ?? "the summary request failed");
		if (response.stopReason === "length") return fallBack("the summary hit the output limit");
		const summary = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
		if (!summary) return fallBack("the model returned no summary text");

		const read = new Set(preparation.fileOps.read);
		const modified = new Set([...preparation.fileOps.written, ...preparation.fileOps.edited]);
		// Pi carries file lists forward only from its own compactions, so carry this extension's lists too.
		const previous = getLatestCompactionEntry(event.branchEntries)?.details;
		if (isPayload(previous)) {
			if (Array.isArray(previous.readFiles)) for (const file of previous.readFiles) if (typeof file === "string") read.add(file);
			if (Array.isArray(previous.modifiedFiles)) for (const file of previous.modifiedFiles) if (typeof file === "string") modified.add(file);
		}
		const readFiles = [...read].filter((file) => !modified.has(file)).sort();
		const modifiedFiles = [...modified].sort();
		const fileSections = [
			readFiles.length > 0 ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "",
			modifiedFiles.length > 0 ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : "",
		].filter(Boolean);

		const { cacheRead, cacheWrite, input } = response.usage;
		const promptTokens = cacheRead + cacheWrite + input;
		if (ctx.hasUI) {
			ctx.ui.notify(
				cacheRead > 0
					? `Cached compaction: ${formatTokens(cacheRead)} of ${formatTokens(promptTokens)} prompt tokens came from the cache.`
					: "Cached compaction finished without a cache hit; the prompt cache had likely expired.",
				cacheRead > 0 ? "info" : "warning",
			);
		}

		return {
			compaction: {
				summary: fileSections.length > 0 ? `${summary}\n\n${fileSections.join("\n\n")}` : summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage: response.usage,
				details: { readFiles, modifiedFiles },
			},
		};
	});
}
