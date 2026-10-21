import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { convertToLlm, getLatestCompactionEntry, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	cacheExpiresAt,
	formatRemaining,
	formatTokens,
	isPayload,
	messageArrayKey,
	entryPreview,
	prefixMismatch,
	reportedCacheTier,
	summaryInstruction,
	trailingMessages,
	withSharedPrefixCache,
	type PrefixMismatch,
} from "./cached-request.ts";
import { loadConfig } from "./config.ts";
import { appendTrace, describeTrace, readTraces, TRACE_PATH, type CompactTrace, type TraceEvent, type TraceUsage, type Trigger } from "./trace.ts";

interface CapturedRequest {
	transcript: AgentMessage[];
	/** The provider payload, compared before sending. Absent for the Claude bridge, which builds no payload Pi sees and checks the prefix itself. */
	payload?: Record<string, unknown>;
	model: Model<Api>;
	at: number;
}

/** A compaction that can take the cached path: the request to extend, and what the branch added since. */
interface CachedPath {
	request: CapturedRequest;
	key?: string;
	trailing: AgentMessage[];
	lifetime?: { ms: number; source: string };
	expiresAt?: number;
}

const STATUS_KEY = "cached-compaction";
const PREFIX_MISMATCH = "pi-cached-compaction: request prefix differs from the cached request";
/** The Claude bridge's provider API. Its requests run in Claude Code, so Pi never sees a payload. */
const BRIDGE_API = "claude-bridge";
/** The bridge's documented header for running one request on a copy of the live Claude Code conversation. */
const FORK_REQUEST_HEADER = "x-claude-bridge-fork";
/** Anthropic's cache lifetimes, for a provider that reports the tier it wrote but declares no lifetime (the Claude bridge). */
const REPORTED_TIER_SECONDS = { short: 300, long: 3600 } as const;
/**
 * OpenAI's guaranteed minimum cache lifetime on GPT-5.6 and later. Pi requests it for both retention
 * settings (it never sends the 12-hour tier). Earlier GPT models only state a typical lifetime.
 */
const OPENAI_MIN_TTL_SECONDS = 1800;

/**
 * OpenAI's own Responses API. There, tool_choice is not part of the cached prefix, and OpenAI
 * recommends tool_choice "none" to disable tools while keeping the cache; on Anthropic the same
 * change invalidates the message cache.
 */
function isOpenAiResponses(model: Model<Api>): boolean {
	return model.provider === "openai" && model.api === "openai-responses";
}

/** GPT-5.6 and later: Pi sends them prompt_cache_options, and OpenAI keeps their cache at least 30 minutes. */
function hasExplicitPromptCache(model: Model<Api>): boolean {
	return model.api === "openai-responses" && (model.compat as { supportsExplicitPromptCacheMode?: boolean } | undefined)?.supportsExplicitPromptCacheMode === true;
}

/**
 * Long retention on GPT-5.6 and later caches the shared prefix for 12 hours under one key per project,
 * so later sessions in the project read it. Undefined when the request keeps Pi's caching as is.
 */
function sharedPrefixKey(model: Model<Api>, cwd: string): string | undefined {
	if (!hasExplicitPromptCache(model) || process.env.PI_CACHE_RETENTION !== "long") return undefined;
	return `pi-${createHash("sha256").update(cwd).digest("hex").slice(0, 40)}`;
}

/** How long before expiry the idle compaction starts, leaving time for the request to reach the provider. */
const EXPIRY_LEAD_MS = 20_000;
const WARNING_MS = 30_000;
/** Records the retention this extension chose, so it can tell its own value (also inherited by child Pi processes) from the user's. */
const RETENTION_MARKER = "PI_CACHED_COMPACTION_RETENTION";
/** Set once an interactive session in this process chose long retention. In-process headless children share the environment. */
const INTERACTIVE_OWNER = Symbol.for("pi-cached-compaction.interactive-long-retention");

/**
 * Cache lifetime of the branch's conversation: the tier its latest cache write reported, else the
 * tier PI_CACHE_RETENTION asks providers for. Undefined when neither the model nor the report gives a lifetime.
 */
function cacheLifetime(model: Model<Api>, entries: SessionEntry[]): { ms: number; source: string } | undefined {
	const reported = reportedCacheTier(entries);
	const tier = reported ?? (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");
	const declared = model.promptCache?.[tier];
	if (declared !== undefined) return { ms: declared * 1000, source: "declared by the model" };
	if (reported) return { ms: REPORTED_TIER_SECONDS[reported] * 1000, source: "reported by the provider" };
	if (hasExplicitPromptCache(model)) return { ms: OPENAI_MIN_TTL_SECONDS * 1000, source: "OpenAI's minimum" };
	return undefined;
}

function traceUsage(usage: { input: number; cacheRead: number; cacheWrite: number; output: number; cost: { total: number } }): TraceUsage {
	return { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, cost: usage.cost.total };
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
	/** What started the compaction in progress, so its outcome is logged against the same trigger. */
	let compactionTrigger: Trigger | undefined;
	let traceError: string | undefined;

	const trace = (ctx: ExtensionContext, event: TraceEvent) => {
		try {
			appendTrace({ ...event, at: new Date().toISOString(), session: ctx.sessionManager.getSessionId() });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI && message !== traceError) ctx.ui.notify(`pi-cached-compaction could not write ${TRACE_PATH}: ${message}`, "warning");
			traceError = message;
		}
	};

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
		if (!config.compactBeforeExpiry) return;
		const secondsLeft = Math.ceil(remainingMs / 1000);
		const tokens = ctx.getContextUsage()?.tokens;
		const contextTokens = tokens ?? undefined;
		let skip: string | undefined;
		if (!captured) skip = "no request since the session started, compacted, or switched model or branch";
		else if (!ctx.isIdle() || ctx.hasPendingMessages()) skip = "Pi is busy or has queued messages";
		else if (contextTokens === undefined) skip = "the context size is unknown";
		else if (contextTokens < config.minContextTokens) {
			skip = `the context holds ${formatTokens(contextTokens)} tokens, under minContextTokens (${formatTokens(config.minContextTokens)})`;
		}
		trace(ctx, { event: "expiry", action: skip ? "skip" : "compact", reason: skip, secondsLeft, contextTokens });
		if (skip || contextTokens === undefined) return;
		expiryCompaction = true;
		// The provider reads the cache when the request starts; counting down past that point would mislead.
		stopTimer(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(`Prompt cache expires in ${secondsLeft}s with ${formatTokens(contextTokens)} tokens of context. Compacting while it is still warm.`, "info");
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
		const ttlMs = ctx.model ? cacheLifetime(ctx.model, ctx.sessionManager.getBranch())?.ms : undefined;
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
		if (!ctx.model || !isPayload(event.payload)) return;
		// Cache-warming replays pass through here too, so they keep the same breakpoints and key.
		const sharedKey = sharedPrefixKey(ctx.model, ctx.cwd);
		const payload = sharedKey ? withSharedPrefixCache(event.payload, sharedKey) : event.payload;
		if (transcript) captured = { transcript, payload, model: ctx.model, at: Date.now() };
		return payload === event.payload ? undefined : payload;
	});
	pi.on("message_start", (event, ctx) => {
		const transcript = pendingTranscript;
		pendingTranscript = undefined;
		// The bridge never sends a payload, so its request is captured once its reply starts.
		if (transcript && event.message.role === "assistant" && ctx.model?.api === BRIDGE_API) captured = { transcript, model: ctx.model, at: Date.now() };
	});
	pi.on("session_start", (_event, ctx) => {
		// Providers read PI_CACHE_RETENTION on every request, so this runs before the session's first one.
		applyRetention(config.cacheRetention === "long", ctx.hasUI);
		startTimer(ctx);
	});
	pi.on("agent_start", (_event, ctx) => stopTimer(ctx));
	pi.on("agent_settled", (_event, ctx) => startTimer(ctx));
	pi.on("session_compact", (event, ctx) => {
		const entry = event.compactionEntry;
		trace(ctx, {
			event: "result",
			trigger: compactionTrigger ?? event.reason,
			by: event.fromExtension ? "extension" : "pi",
			entryId: entry.id,
			tokensBefore: entry.tokensBefore,
			usage: entry.usage ? traceUsage(entry.usage) : undefined,
			summaryChars: entry.summary.length,
		});
		compactionTrigger = undefined;
		forget(ctx);
	});
	pi.on("session_compact_failed", (event, ctx) => {
		trace(ctx, { event: "failed", trigger: compactionTrigger ?? event.reason, aborted: event.aborted, error: event.errorMessage });
		compactionTrigger = undefined;
	});
	pi.on("model_select", (_event, ctx) => forget(ctx));
	pi.on("session_tree", (_event, ctx) => {
		forget(ctx);
		startTimer(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => stopTimer(ctx));

	/** Whether a compaction now could take the cached path, short of the prefix check that runs when it does. */
	const checkCachedPath = (entries: SessionEntry[], model: Model<Api> | undefined): CachedPath | { reason: string } => {
		const request = captured;
		if (!request) return { reason: "no request since the session started, compacted, or switched model or branch" };
		if (model?.provider !== request.model.provider || model.id !== request.model.id) return { reason: "the model changed since the last request" };
		const key = request.payload ? messageArrayKey(request.payload) : undefined;
		if (request.payload && !key) return { reason: `${request.model.api} requests are not supported` };
		const trailing = trailingMessages(entries, request.transcript);
		if ("reason" in trailing) return { reason: `the conversation changed since the last request: ${trailing.reason}` };
		// A cold cache makes the full prompt cost more than Pi's default, which sends only the summarized messages.
		const lifetime = cacheLifetime(request.model, entries);
		// Without a known lifetime this still shows whether the last request used the cache at all.
		const expiresAt = cacheExpiresAt(entries, lifetime?.ms ?? 0);
		if (expiresAt === undefined) return { reason: "the last request did not use the prompt cache" };
		if (lifetime && Date.now() >= expiresAt) return { reason: "the prompt cache has expired" };
		return { request, key, trailing: trailing.messages, lifetime, expiresAt: lifetime ? expiresAt : undefined };
	};

	pi.on("session_before_compact", async (event, ctx) => {
		// A compaction started for an expiring cache only pays off on the cached path.
		const fromExpiry = expiryCompaction;
		const trigger: Trigger = fromExpiry ? "expiry" : event.reason;
		compactionTrigger = trigger;
		const { preparation } = event;
		const record: CompactTrace = {
			event: "compact",
			trigger,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none",
			outcome: "cached",
			tokensBefore: preparation.tokensBefore,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
		};
		const fallBack = (reason: string, mismatch?: PrefixMismatch) => {
			const diff = mismatch?.captured === undefined ? undefined : { captured: mismatch.captured, rebuilt: mismatch.rebuilt };
			trace(ctx, { ...record, outcome: fromExpiry ? "cancelled" : "fallback", reason, mismatch: diff });
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
		if (event.reason === "overflow") return fallBack("the last request overflowed the context window");
		const check = checkCachedPath(event.branchEntries, ctx.model);
		if ("reason" in check) return fallBack(check.reason);
		const { request, key, trailing, lifetime, expiresAt } = check;
		const lastReply = event.branchEntries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		const lastUsage = lastReply?.type === "message" && lastReply.message.role === "assistant" ? lastReply.message.usage : undefined;
		record.lastRequest = {
			secondsAgo: Math.round((Date.now() - request.at) / 1000),
			messages: request.transcript.length,
			promptTokens: lastUsage && lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite,
			newMessages: trailing.length,
		};
		record.cache = {
			lifetimeSeconds: lifetime && lifetime.ms / 1000,
			source: lifetime?.source,
			expiresInSeconds: expiresAt === undefined ? undefined : Math.round((expiresAt - Date.now()) / 1000),
		};

		const keptEntry = event.branchEntries.find((entry) => entry.id === preparation.firstKeptEntryId);
		const keptStart = keptEntry ? entryPreview(keptEntry) : undefined;
		const instruction: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: summaryInstruction(keptStart, event.customInstructions) }],
			timestamp: Date.now(),
		};

		// Same model, thinking level, and session id as the agent, so Pi serializes the same prefix.
		// onPayload proves it against the captured request before anything is sent. The bridge has no
		// payload to compare: the header makes it copy the live Claude Code conversation instead.
		let mismatch: PrefixMismatch | undefined;
		const thinkingLevel = pi.getThinkingLevel();
		const payload = request.payload;
		const controller = new AbortController();
		const disableTools = payload !== undefined && isOpenAiResponses(request.model);
		const cacheNeutral = new Set(disableTools ? ["tool_choice"] : []);
		const sharedKey = payload ? sharedPrefixKey(request.model, ctx.cwd) : undefined;
		record.request = { thinking: thinkingLevel, bridgeFork: payload === undefined, toolChoiceNone: disableTools, sharedPrefix: sharedKey !== undefined };
		const started = Date.now();
		let response: AssistantMessage;
		try {
			response = await ctx.modelRegistry
				.streamSimple(request.model, { messages: convertToLlm([...request.transcript, ...trailing, instruction]) }, {
				reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
				sessionId: ctx.sessionManager.getSessionId(),
				signal: AbortSignal.any([event.signal, controller.signal]),
				...(disableTools ? { toolChoice: "none" as const } : {}),
				...(payload && key
					? {
						onPayload: (params: unknown) => {
							if (!isPayload(params)) {
								mismatch = { reason: "the provider payload is not an object" };
								throw new Error(PREFIX_MISMATCH);
							}
							const sent = sharedKey ? withSharedPrefixCache(params, sharedKey) : params;
							mismatch = prefixMismatch(payload, sent, key, cacheNeutral);
							if (mismatch) throw new Error(PREFIX_MISMATCH);
							return sent;
						},
					}
					// "none" marks a one-shot, which a bridge without fork requests runs apart from the session.
					: { headers: { [FORK_REQUEST_HEADER]: "1" }, cacheRetention: "none" as const }),
				})
				.result();
		} catch (error) {
			// Pi would run its default after a throwing handler anyway; this way the log says why.
			return fallBack(`the summary request threw: ${error instanceof Error ? error.message : String(error)}`);
		}
		// A bridge query that called a tool waits for its result; aborting ends it.
		if (response.stopReason === "toolUse") controller.abort();
		const summary = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
		record.response = {
			stopReason: response.stopReason,
			seconds: (Date.now() - started) / 1000,
			usage: traceUsage(response.usage),
			summaryChars: summary.length,
			error: mismatch ? undefined : response.errorMessage,
		};

		if (response.stopReason === "aborted") {
			trace(ctx, { ...record, outcome: "cancelled", reason: "the compaction was aborted" });
			return { cancel: true };
		}
		if (mismatch) return fallBack(mismatch.reason, mismatch);
		if (response.stopReason === "error") return fallBack(response.errorMessage ?? "the summary request failed");
		if (response.stopReason === "length") return fallBack("the summary hit the output limit");
		if (response.stopReason === "toolUse") return fallBack("the model called a tool instead of writing the summary");
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

		trace(ctx, record);
		const { cacheRead, cacheWrite, input } = response.usage;
		const promptTokens = cacheRead + cacheWrite + input;
		if (ctx.hasUI) {
			ctx.ui.notify(
				cacheRead > 0
					? `Cached compaction: ${Math.floor((100 * cacheRead) / promptTokens)}% of ${formatTokens(promptTokens)} prompt tokens came from the cache.`
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

	pi.registerCommand("cached-compaction", {
		description: "Show the prompt cache state and this session's compaction log",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const model = ctx.model;
			const duration = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
			const lifetime = model ? cacheLifetime(model, entries) : undefined;
			const expiresAt = lifetime ? cacheExpiresAt(entries, lifetime.ms) : undefined;
			const replied = entries
				.slice(entries.findLastIndex((entry) => entry.type === "compaction") + 1)
				.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted");
			const cache = !lifetime
				? "lifetime unknown, so no countdown"
				: expiresAt === undefined
					? `${replied ? "the last request used no cache" : "no request since the session started or compacted"} (lifetime ${duration(lifetime.ms)}, ${lifetime.source})`
					: `${expiresAt > Date.now() ? `${formatRemaining(expiresAt - Date.now())} left` : "expired"} (lifetime ${duration(lifetime.ms)}, ${lifetime.source})`;
			const check = checkCachedPath(entries, model);
			const next = "reason" in check
				? `Pi's default, because ${check.reason}`
				: `cached path; last request ${duration(Date.now() - check.request.at)} ago with ${check.request.transcript.length} messages, ${check.trailing.length} since. The request prefix is checked when it runs.`;
			let log: string[];
			try {
				const records = readTraces(ctx.sessionManager.getSessionId(), 12);
				log = records.length > 0 ? ["This session:", ...records.map(describeTrace)] : ["Nothing logged for this session yet."];
			} catch (error) {
				log = [`Could not read the log: ${error instanceof Error ? error.message : String(error)}`];
			}
			const logPath = TRACE_PATH.startsWith(homedir()) ? `~${TRACE_PATH.slice(homedir().length)}` : TRACE_PATH;
			ctx.ui.notify(
				[
					`pi-cached-compaction · ${model ? `${model.provider}/${model.id}` : "no model"}`,
					`cache: ${cache}`,
					`next compaction: ${next}`,
					`before expiry: ${config.compactBeforeExpiry ? `on, from ${formatTokens(config.minContextTokens)} tokens of context` : "off"} · retention ${process.env.PI_CACHE_RETENTION ?? "short"}`,
					`log: ${logPath}`,
					"",
					...log,
				].join("\n"),
				"info",
			);
		},
	});
}
