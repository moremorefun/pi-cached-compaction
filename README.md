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
```

The summary uses Pi's checkpoint format, keeps Pi's recent-message window, and carries read/modified file lists forward like the default. Whether it also costs less depends on what the session holds; see [What it costs](#what-it-costs).

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

## What it costs

Pi's default compaction sends only the messages it summarizes, as text, and cuts each tool result to 2,000 characters. It pays full price for all of it. This extension sends the whole session and pays the cache-read price for nearly all of it. Which one costs less depends on what the session holds. Measured with GPT through opencode-go, at the prices in Pi's model catalog:

| Session at compaction | Pi default | pi-cached-compaction |
|---|---|---|
| 44k tokens, mostly tool output (`gpt-6-luna`) | 5.9k sent, $0.00090 | 44k sent, 99% cached, $0.00097 |
| 44k tokens, mostly tool output (`gpt-5.6-luna`) | 5.9k sent, $0.00189 | 45k sent, 99% cached, $0.00190 |
| 9k tokens, mostly long answers (`gpt-6-luna`) | 4.9k sent, $0.00087 | 8.8k sent, 94% cached, $0.00050 |
| 10k tokens, mostly long answers (`gpt-5.6-luna`) | 6.0k sent, $0.00224 | 10k sent, 95% cached, $0.00123 |
| 2k tokens, a few tool calls (`gpt-6-luna`) | 0.3k sent, $0.00009 | 2.2k sent, 83% cached, $0.00035 |

In tool-heavy sessions the two come out about even. The cached path's input cost less ($0.00049 against $0.00074 on `gpt-6-luna`), but the model reasoned longer over the full context. For the same price, the summary is written from the full tool output instead of 2,000-character excerpts. When the session is mostly conversation, the default sends all of it at full price, and this extension costs 42–45% less. In very small sessions the default is cheaper. On these opencode-go models, Pi's default also pays OpenAI's 1.25× cache-write price, because Pi can't turn caching off through opencode-go.

## Cache timer and compacting before expiry

In interactive sessions the extension turns on Pi's long cache retention (`PI_CACHE_RETENTION=long`) unless you've set that variable yourself. Anthropic caches then last 1 hour instead of 5 minutes. Anthropic charges 2× input price to write a 1-hour cache instead of 1.25×, and reads cost the same. On OpenAI the setting matters less: see [With OpenAI models](#with-openai-models). Headless runs (`pi -p`, JSON mode, subagent processes) keep the 5-minute cache, because nobody pauses there and the higher write price would be wasted.

The choice is made once per session because a cache can't move up a tier cheaply. Measured through Claude Code on Anthropic:

```
 5m entry, then a 1h request   → full rewrite at 2×       (42,132 tokens written)
 1h entry, then a 5m request   → read as normal           (53,459 read, 67 written)
 idle 8 min on 5m              → expired, rewrite         (39,707 written)
 idle 8 min on 1h              → still warm
```

So "5 minutes while working, 1 hour when idle" costs more than choosing 1 hour from the start. With the 1-hour cache, Pi's own cache warmer rarely fires, which is fine: it stops after 30 idle minutes, before a 1-hour cache needs a refresh.

While Pi is idle, the footer shows how long the cache has left: `⏱ 42m`, then `⏱ 0:45`, turning to the warning color in the last 30 seconds and to `cache cold` once it expires. The lifetime comes from the cache tier the provider reports it wrote (Pi's Anthropic provider and pi-claude-bridge report it), else from the model's declared lifetime. Models with neither show no countdown; you can declare a lifetime yourself, as shown for opencode-go [below](#with-openai-models). In powerline-footer it shows in the `extension_statuses` segment.

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

OpenAI caches the same way in principle: a matching prefix reads at 0.1× the input price (0.05× on GPT-6.1 Sol), and GPT-5.6 and later charge 1.25× to write it. OpenAI documents a minimum of 30 minutes for GPT-5.6 and later; for earlier models it says "typically 5 to 10 minutes" in memory, or about 30 minutes with 24-hour retention. What the extension does depends on the provider:

```
                    openai provider                  opencode-go
countdown           ⏱ 30m on GPT-5.6 and later       none until you declare a lifetime (below)
long retention      GPT-5.6+: ttl "30m" (default)    Pi sends the older "24h" field: no effect measured
reasoning effort    GPT-6: item after the cache      request field: a thinking change falls back
tool_choice         "none" on the summary request    left alone
tested live         not yet (no API credits)         yes, see Live test results
```

**Countdown on opencode-go.** Pi declares no cache lifetime for opencode-go's GPT models. So there's no countdown, and a compaction after a long pause sends the whole session to a cold cache at the 1.25× write price. Declare OpenAI's 30-minute minimum in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "opencode-go": {
      "modelOverrides": {
        "gpt-6-luna": { "promptCache": { "short": 1800, "long": 1800 } },
        "gpt-5.6-luna": { "promptCache": { "short": 1800, "long": 1800 } }
      }
    }
  }
}
```

Through opencode-go the cache was still warm after 12, 17, and 24 idle minutes, and gone after 32 and 62 with either retention setting. With the lifetime declared, the countdown and `compactBeforeExpiry` work, and a compaction after the cache expires goes to Pi's default instead. Declaring a lifetime also makes these models eligible for Pi's cache warmer during long runs, which only fires when it saves at least $0.05.

**`tool_choice`.** OpenAI's guide recommends `tool_choice: "none"` to stop tool calls without changing the cached prefix, so the extension sets it on the `openai` provider and the prefix check ignores that one field. Measured on the same GPT models through opencode-go, it isn't quite free: the summary request read exactly 72 fewer tokens from the cache every time, at any session size. On Grok through opencode-go it cut the cache off after the tool definitions (62–69% instead of 90%). So on every other provider the extension leaves `tool_choice` alone and tells the model not to call tools. No model called one in any test.

GPT-6 models on the `openai` provider carry the reasoning effort as a trailing `configuration_update` item. It sits after the cache breakpoint, so the check treats it like Anthropic's trailing effort message. That path is checked against Pi's own OpenAI serializer for `gpt-6.1-sol` and `gpt-5.5`, but hasn't run live. On `openai-codex` (ChatGPT sign-in), the request is left exactly as Pi builds it and no countdown is shown: that backend documents no cache lifetime.

## Live test results

Run on 2026-10-21 with Pi 1.3.0 in RPC mode, with a logger recording each request's cache fields and the cache usage the provider reported. Unless noted, a run makes three tool-using turns (read, edit, bash), runs `/compact`, makes one more edit, and runs `/compact` again. The percentage is the share of the summary request's prompt read from the cache. In these small sessions the summary instruction, about 350 new tokens, keeps it in the 80s: the summary request read everything the previous turn had sent except its last 3 tokens.

| Model | API | Two compactions |
|---|---|---|
| `pi-claude/claude-opus-5-5` | Claude Code (bridge) | 96%, 96%; 99%, 99% with a full set of other extensions |
| `pi-claude/claude-sonnet-5-5` | Claude Code (bridge) | 96%, 96% |
| `opencode-go/claude-haiku-5-5` | Anthropic Messages | 86%, 87% |
| `opencode-go/gpt-6-luna` | OpenAI Responses | 83–84%, 85–86% |
| `opencode-go/gpt-5.6-luna` | OpenAI Responses | 83–84%, 84–86% |
| `opencode-go/grok-4.7` | OpenAI Responses | 90%, 90% |
| `opencode-go/kimi-k2.7-code` | OpenAI Chat Completions | 79%, 86% |

`deepseek-v4.1-flash` and `muse-spark-1.3-contributor` didn't run: opencode-go rejects them until the workspace allows Global regions, or endpoints that train on request data. With every turn failing, the extension handed compaction to Pi's default, which failed the same way.

GPT through opencode-go, `gpt-6-luna` / `gpt-5.6-luna`:

| Scenario | Result |
|---|---|
| Thinking off, high, or xhigh; long or short retention | all cached, 83–86% |
| 44k-token session (ten docs read) | 99% / 99% |
| Same with a full set of other extensions loaded (62k tokens) | 99% / 99% |
| Automatic compaction, triggered three times mid-run | 77, 82, 80% / 80, 81, 85% |
| Idle 12, 17, or 24 minutes, then `/compact` | 83–84% every time |
| Idle 32 or 62 minutes, long or short retention | 0%: the cache had expired |
| Declared 75 s lifetime, `compactBeforeExpiry` on | compacted 20 s before expiry, 83% / 84% |
| Declared 75 s lifetime, `/compact` after 2 idle minutes | skipped (cache expired), Pi's default ran |
| Thinking level changed before `/compact` | skipped (`request field "reasoning" differs`), Pi's default ran |
| Model switched before `/compact` | skipped (nothing sent to this model yet), Pi's default ran |
| `tool_choice: "none"` on the summary request | 72 fewer tokens read from the cache, every time |

Every run that used tools left the edited file correct. Cost comparisons with Pi's default are in [What it costs](#what-it-costs).

## Limitations

- Outside the `openai` provider, the model sees your tools during the summary request and is told not to call them, because changing `tool_choice` costs cache there: on Anthropic it discards the message cache. If it calls a tool or replies with no summary text, Pi's default compaction runs.
- Without a reported or declared cache lifetime, the extension can't tell a cold cache from a warm one, so a compaction after a long pause pays to rewrite the whole session. Declare the lifetime as shown for opencode-go above.
- If another extension rewrites provider payloads after this one, the request can miss the cache. The summary is still correct, it just costs about what the default would.
