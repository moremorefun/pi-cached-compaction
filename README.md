# pi-cached-compaction

Pi's built-in compaction sends the conversation to the model as a new request with its own system prompt, so it never reads the prompt cache your session just paid to build. This extension sends the summary request as the next turn of the same conversation instead. The provider then reads almost all of it from the cache, at about a tenth of the normal input price on Anthropic and OpenAI.

```
YOUR SESSION (already cached, warm)
┌──────────────────────────────────────────────────────────────┐
│ [tools] [system prompt] [msg 1] [msg 2] ... [msg N]          │
└──────────────────────────────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━  PI'S DEFAULT COMPACTION  ━━━━━━━━━━━━━━━━━━━━━━

 ┌───────────────────────────────┬─────────────────────────────────┐
 │ "You are a context            │ "[User]: ... [Assistant]: ...   │
 │  summarization assistant"     │  [Tool result]: (cut to 2k)..." │
 │ (different system prompt)     │  only the OLD msgs, as text     │
 └───────────────────────────────┴─────────────────────────────────┘
   ▲ differs from token 1           ▲ text, not real messages
   no tools, cacheRetention: "none"

 cache:   ✗✗✗✗✗✗✗✗✗✗✗✗✗✗✗✗✗✗✗✗  0% hit, every token at 1.0×
 sees:    old messages only, tool output cut to 2,000 chars

━━━━━━━━━━━━━━━━━━━━━━━━━  PI-CACHED-COMPACTION  ━━━━━━━━━━━━━━━━━━━━━━━━━

 ┌──────────────────────────────────────────────────────┬───────────┐
 │ [tools] [system prompt] [msg 1] ... [msg N]          │ "Summarize│
 │  byte-for-byte the same as your last turn            │  above"   │
 └──────────────────────────────────────────────────────┴───────────┘
                                                          ▲ tiny new tail
 cache:   ✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓·  ~95% hit at ~0.1×
 sees:    the full conversation, tools included, nothing cut

━━━━━━━━━━━━━━━━━━━━━━━━━  RESULT (same for both)  ━━━━━━━━━━━━━━━━━━━━━━━━━

 ┌──────────┬──────────┬───────────────────────────┐
 │ system   │ SUMMARY  │ recent msgs kept verbatim │
 └──────────┴──────────┴───────────────────────────┘

 Example, 180k context near the limit:
   default:  ~150k old msgs × 1.0×         ≈ 150k token-cost
   cached:   ~180k × 0.1× + small tail     ≈  20k token-cost
```

The summary uses Pi's checkpoint format, keeps Pi's recent-message window, and carries read/modified file lists forward like the default.

## Install

Put this folder in `~/.pi/agent/extensions/pi-cached-compaction` (or install it as a Pi package), then `/reload`. It needs Pi 0.87.0 or newer.

## What you'll see

On `/compact` or automatic compaction, a notice reports the cache hit:

```
Cached compaction: 95% of 190k prompt tokens came from the cache.
```

When it can't guarantee a cache hit, it says why and lets Pi's default compaction run:

```
Cached compaction skipped (the prompt cache has expired). Using Pi's default compaction.
```

Measured on `opencode-go/kimi-k2.6` with a 9k-token session (most of it Pi's system prompt and tools):

| Compaction | Prompt tokens sent | Read from cache |
|---|---|---|
| Pi default | 952 | 0 |
| pi-cached-compaction | 9,133 | 8,192 |

In a small session like this one, the default sends fewer tokens, because it skips the system prompt, the tools, and the recent messages. The savings grow with the session. When compaction runs near the context limit, the default pays full price for the whole summarized history, while this extension pays the cache-read price for nearly all of it.

Tested live with tool calls (read, edit, bash) followed by two compactions, both read from the cache: `pi-claude/claude-opus-5-5` and `claude-sonnet-5-5` (96%, or 99% with a full set of other extensions loaded), `opencode-go/claude-haiku-5-5` (86–87%), `opencode-go/gpt-6-luna` and `gpt-5.6-luna` (84–86%), and `opencode-go/kimi-k2.7-code` (79–86%).

## Cache timer and compacting before expiry

In interactive sessions the extension turns on Pi's long cache retention (`PI_CACHE_RETENTION=long`) unless you've set that variable yourself. Anthropic caches then last 1 hour instead of 5 minutes, and OpenAI caches 24 hours. Anthropic charges 2× input price to write a 1-hour cache instead of 1.25×, and reads cost the same. Headless runs (`pi -p`, JSON mode, subagent processes) keep the 5-minute cache, because nobody pauses there and the higher write price would be wasted.

The choice is made once per session because a cache can't move up a tier cheaply. Measured through Claude Code on Anthropic:

```
 5m entry, then a 1h request   → full rewrite at 2×       (42,132 tokens written)
 1h entry, then a 5m request   → read as normal           (53,459 read, 67 written)
 idle 8 min on 5m              → expired, rewrite         (39,707 written)
 idle 8 min on 1h              → still warm
```

So "5 minutes while working, 1 hour when idle" costs more than choosing 1 hour from the start. With the 1-hour cache, Pi's own cache warmer rarely fires, which is fine: it stops after 30 idle minutes, before a 1-hour cache needs a refresh.

While Pi is idle, the footer shows how long the cache has left: `⏱ 42m`, then `⏱ 0:45`, turning to the warning color in the last 30 seconds and to `cache cold` once it expires. The lifetime comes from the cache tier the provider reports it wrote (Pi's Anthropic provider and pi-claude-bridge report it), else from the model's declared lifetime. Other providers show no countdown. In powerline-footer it shows in the `extension_statuses` segment.

With `compactBeforeExpiry` on, Pi compacts 20 seconds before the cache expires, but only when it's idle, nothing is queued, the context holds at least `minContextTokens` tokens, and the cached path is available. Otherwise nothing happens. Sending a message resets the timer. The threshold is in tokens rather than percent because the cost of rewriting an expired cache depends on its size, and on 1M-token models a percentage would almost never trigger.

```json
{
  "cachedCompaction": {
    "cacheRetention": "long",
    "compactBeforeExpiry": true,
    "minContextTokens": 50000
  }
}
```

Put this in `~/.pi/agent/settings.json`. The defaults are `"long"`, `false`, and `50000`.

## How it stays safe

Before anything is sent, the extension rebuilds the request with Pi's own serializer and compares it field by field with the last real request. If any part of the cached prefix would differ, it doesn't send its request and Pi's default compaction runs instead. That covers a different thinking level, an edited history, tree navigation, or a model switch.

```
 rebuild request ──► compare with last real request
                       ├─ identical prefix ──► send ✅
                       └─ any difference ───► send nothing
                                              └─► Pi's default compaction
```

It also steps aside when:

- the model's declared cache lifetime has passed since the last request or cache-warming refresh, or the last successful request didn't use the cache. A cold cache makes the full prompt cost more than the default.
- compaction is recovering from a context overflow
- the provider builds no HTTP payload Pi can see (other than pi-claude-bridge, below)
- the API isn't a `messages` or `input` style payload (Anthropic, OpenAI Chat Completions, OpenAI Responses). Google isn't supported yet.

## With pi-claude-bridge

`pi-claude/*` models run in Claude Code, so there's no payload to compare. Instead, the extension sends the summary request with the bridge's `x-claude-bridge-fork: 1` header. The bridge runs it on a copy of the live Claude Code conversation, which reads its prompt cache, and deletes the copy afterwards. The live conversation is only read. If the bridge can't copy the conversation, it imports the history instead, and the notice reports the missing cache hit.

Measured on `pi-claude/claude-haiku-4-5` after three turns: 10,793 of 11,437 prompt tokens came from the cache, the main Claude Code transcript was unchanged, and the copy was deleted. Claude Code reports a 1-hour cache on a subscription, so the countdown shows `⏱ 59m`. The request is also marked as a one-shot, so a bridge without fork support runs it apart from the live conversation: the summary still works, just without the cache hit.

## With OpenAI models

OpenAI caches the same way in principle (a matching prefix reads at 0.1×, or 0.05× on GPT-6.1 Sol), with a few differences the extension follows:

```
                    GPT-5.6 and later           earlier GPT models
lifetime            at least 30 min (default)   "typically" 5-10 min, or ~30 min with 24h retention
long retention      Pi keeps 30 min (no 12h)    24h, no write charge
countdown           ⏱ shown (30 min)            none (no guaranteed lifetime)
```

- On the `openai` provider the summary request sets `tool_choice: "none"`. OpenAI keeps `tool_choice` out of the cached prefix and recommends it for exactly this, so the model can't call a tool and the cache still matches. The prefix check ignores that one field and nothing else.
- GPT-6 models carry the reasoning effort as a trailing `configuration_update` item. It sits after the cache breakpoint, so the check treats it like Anthropic's trailing effort message.
- On `openai-codex` (ChatGPT sign-in), the request is left exactly as Pi builds it and no countdown is shown: that backend documents no cache lifetime.

Checked against Pi's own OpenAI serializer for `gpt-6.1-sol` and `gpt-5.5`: the summary request matches the previous request's prefix, and `tool_choice` is the only other field that changes. GPT models on the same Responses API have run live through `opencode-go`, but the `openai` provider itself, where `tool_choice: "none"` applies, hasn't been run live yet.

## Limitations

- On Anthropic and pi-claude-bridge, the model sees your tools during the summary request and is told not to call them, because changing `tool_choice` there would discard the message cache. If it calls a tool or replies with no summary text, Pi's default compaction runs.
- If another extension rewrites provider payloads after this one, the request can miss the cache. The summary is still correct, it just costs about what the default would.
