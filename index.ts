import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { convertToLlm, getLatestCompactionEntry, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	cacheExpiresAt,
	formatRemaining,
	isPayload,
	messageArrayKey,
	entryPreview,
	prefixMismatch,
	summaryInstruction,
	trailingMessages,
} from "./cached-request.ts";
import { loadConfig } from "./config.ts";

interface CapturedRequest {
	transcript: AgentMessage[];
	payload: Record<string, unknown>;
	model: Model<Api>;
}

const STATUS_KEY = "cached-compaction";
const PREFIX_MISMATCH = "pi-cached-compaction: request prefix differs from the cached request";
/** How long before expiry the idle compaction starts, leaving time for the request to reach the provider. */
const EXPIRY_LEAD_MS = 20_000;
const WARNING_MS = 30_000;
/** Records the retention this extension chose, so it can tell its own value (also inherited by child Pi processes) from the user's. */
const RETENTION_MARKER = "PI_CACHED_COMPACTION_RETENTION";
/** Set once an interactive session in this process chose long retention. In-process headless children share the environment. */
const INTERACTIVE_OWNER = Symbol.for("pi-cached-compaction.interactive-long-retention");

function formatTokens(count: number): string {
	return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

/** Cache lifetime for the retention tier Pi's providers will request, when the model declares one. */
function cacheTtlMs(model: Model<Api>): number | undefined {
	const seconds = model.promptCache?.[process.env.PI_CACHE_RETENTION === "long" ? "long" : "short"];
	return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * The 1-hour tier only pays off across human pauses, and a cache cannot move up a tier without
 * a full rewrite, so the choice is made once per session: long when interactive, short when headless.
 */
function applyRetention(preferLong: boolean, interactive: boolean): void {
	const current = process.env.PI_CACHE_RETENTION;
	if (current !== undefined && process.env[RETENTION_MARKER] !== current) return;
	const host = globalThis as Record<symbol, unknown>;
	if (preferLong && interactive) {
		process.env.PI_CACHE_RETENTION = process.env[RETENTION_MARKER] = "long";
		host[INTERACTIVE_OWNER] = true;
	} else if (interactive || !host[INTERACTIVE_OWNER]) {
		delete process.env.PI_CACHE_RETENTION;
		delete process.env[RETENTION_MARKER];
		host[INTERACTIVE_OWNER] = false;
	}
}

export default function cachedCompaction(pi: ExtensionAPI) {
	const config = loadConfig();

	let pendingTranscript: AgentMessage[] | undefined;
	let captured: CapturedRequest | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let expiryCompaction = false;

	const stopTimer = (ctx: ExtensionContext) => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	};
	const forget = (ctx: ExtensionContext) => {
		pendingTranscript = undefined;
		captured = undefined;
		stopTimer(ctx);
	};

	const compactBeforeExpiry = (ctx: ExtensionContext, remainingMs: number) => {
		if (!config.compactBeforeExpiry || !captured || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens === null || tokens === undefined || tokens < config.minContextTokens) return;
		expiryCompaction = true;
		// The provider reads the cache when the request starts; counting down past that point would mislead.
		stopTimer(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(`Prompt cache expires in ${Math.ceil(remainingMs / 1000)}s with ${formatTokens(tokens)} tokens of context. Compacting while it is still warm.`, "info");
		}
		ctx.compact({
			onComplete: () => {
				expiryCompaction = false;
			},
			onError: () => {
				expiryCompaction = false;
			},
		});
	};

	const startTimer = (ctx: ExtensionContext) => {
		stopTimer(ctx);
		const ttlMs = ctx.model ? cacheTtlMs(ctx.model) : undefined;
		if (ttlMs === undefined) return;
		let expiresAt = cacheExpiresAt(ctx.sessionManager.getBranch(), ttlMs);
		if (expiresAt === undefined) return;
		let shown: string | undefined;
		let ticks = 0;
		let attempted = false;
		const tick = () => {
			// Pi's idle cache warmer can push expiry out; re-read it periodically and before acting on it.
			if (++ticks % 15 === 0 || (expiresAt as number) - Date.now() <= EXPIRY_LEAD_MS) {
				expiresAt = cacheExpiresAt(ctx.sessionManager.getBranch(), ttlMs) ?? expiresAt;
			}
			const remaining = (expiresAt as number) - Date.now();
			const text = formatRemaining(remaining);
			if (ctx.hasUI && text !== shown) {
				shown = text;
				ctx.ui.setStatus(STATUS_KEY, remaining <= WARNING_MS ? ctx.ui.theme.fg(remaining > 0 ? "warning" : "dim", text) : text);
			}
			if (remaining <= 0) {
				clearInterval(ticker);
				ticker = undefined;
			} else if (remaining <= EXPIRY_LEAD_MS && !attempted) {
				attempted = true;
				compactBeforeExpiry(ctx, remaining);
			}
		};
		ticker = setInterval(tick, 1000);
		ticker.unref?.();
		tick();
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
		captured = { transcript, payload: event.payload, model: ctx.model };
	});
	pi.on("message_start", () => {
		pendingTranscript = undefined;
	});
	pi.on("session_start", (_event, ctx) => {
		// Providers read PI_CACHE_RETENTION on every request, so this runs before the session's first one.
		applyRetention(config.cacheRetention === "long", ctx.hasUI);
		startTimer(ctx);
	});
	pi.on("agent_start", (_event, ctx) => stopTimer(ctx));
	pi.on("agent_settled", (_event, ctx) => startTimer(ctx));
	pi.on("session_compact", (_event, ctx) => forget(ctx));
	pi.on("model_select", (_event, ctx) => forget(ctx));
	pi.on("session_tree", (_event, ctx) => {
		forget(ctx);
		startTimer(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => stopTimer(ctx));

	pi.on("session_before_compact", async (event, ctx) => {
		// A compaction started for an expiring cache only pays off on the cached path.
		const fromExpiry = expiryCompaction;
		const fallBack = (reason: string) => {
			if (ctx.hasUI) {
				ctx.ui.notify(
					fromExpiry
						? `Skipped compacting before cache expiry (${reason}).`
						: `Cached compaction skipped (${reason}). Using Pi's default compaction.`,
					"info",
				);
			}
			return fromExpiry ? { cancel: true } : undefined;
		};
		const request = captured;
		if (!request) return fromExpiry ? { cancel: true } : undefined;
		if (event.reason === "overflow") return fallBack("the last request overflowed the context window");
		if (ctx.model?.provider !== request.model.provider || ctx.model.id !== request.model.id) {
			return fallBack("the model changed since the last request");
		}
		const key = messageArrayKey(request.payload);
		if (!key) return fallBack(`${request.model.api} requests are not supported`);
		const trailing = trailingMessages(event.branchEntries, request.transcript);
		if (!trailing) return fallBack("the conversation changed since the last request");
		// A cold cache makes the full prompt cost more than Pi's default, which sends only the summarized messages.
		const ttlMs = cacheTtlMs(request.model);
		if (ttlMs !== undefined) {
			const expiresAt = cacheExpiresAt(event.branchEntries, ttlMs);
			if (expiresAt === undefined) return fallBack("the last request did not use the prompt cache");
			if (Date.now() >= expiresAt) return fallBack("the prompt cache has expired");
		}

		const { preparation } = event;
		const keptEntry = event.branchEntries.find((entry) => entry.id === preparation.firstKeptEntryId);
		const keptStart = keptEntry ? entryPreview(keptEntry) : undefined;
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
