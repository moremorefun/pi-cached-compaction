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

After each compaction, a card below the summary shows which path ran and what the cache returned. It's saved with the session, so it's still there after a resume, and it's never sent to the model:

```
cached compaction  (ctrl+o for details)
13:48:46 /compact: cached, 83% of 2k from cache, 405 out, $0.0003 (last turn sent 2k), 5.4s, summary 634 chars
13:48:46   saved, 2k tokens summarized
```

When it can't guarantee a cache hit, the card says why and shows what Pi's default compaction did instead. Expanding it (ctrl+o) adds what the decision rested on:

```
cached compaction
13:48:54 /compact: Pi's default, request field "reasoning" differs
         cache: lifetime 30 min (OpenAI's minimum), 30 min left
         last request: 4 s ago, 20 messages, 2k prompt tokens, 1 new since
         request: thinking low, shared 12h prefix
         last request had: {"effort":"high","summary":"auto"}
         summary request had: {"effort":"low","summary":"auto"}
13:48:59   Pi's default compaction saved: 0% of 923 from cache, 384 out, $0.0003, summary 1243 chars
log: ~/.pi/agent/cached-compaction.jsonl
```

### Checking what happened

`/cached-compaction` shows the cache right now, whether the next compaction would use it, and this session's log:

```
pi-cached-compaction · opencode-go/gpt-6-luna
cache: ⏱ 29m left (lifetime 30 min, OpenAI's minimum)
next compaction: cached path; last request 4 s ago with 14 messages, 1 since. The request prefix is checked when it runs.
before expiry: on, from 50k tokens of context · retention long
log: ~/.pi/agent/cached-compaction.jsonl

This session:
11:48:34 /compact: cached, 83% of 2k from cache, 405 out, $0.0003 (last turn sent 2k), 4.8s, summary 669 chars
11:48:34   saved, 2k tokens summarized
11:48:40 /compact: Pi's default, request field "reasoning" differs
11:48:47   Pi's default compaction saved: 0% of 964 from cache, 381 out, $0.0003, summary 1131 chars
11:52:37 cache expires in 20s: not compacting, the context holds 2k tokens, under minContextTokens (50k)
```

Every session appends to `~/.pi/agent/cached-compaction.jsonl` (moved to `.1` past 5 MB). There's one line per compaction decision, with what triggered it, each check's result, the request settings, the provider's cache usage, and timing. Pi's saved result or failure gets its own line, and so does each compact-before-expiry decision. When the request prefix doesn't match, the line shows the text around the first difference:

```json
"reason": "request field \"reasoning\" differs",
"mismatch": { "captured": "{\"effort\":\"high\",\"summary\":\"auto\"}", "rebuilt": "{\"effort\":\"low\",\"summary\":\"auto\"}" }
```

```sh
jq -c 'select(.event == "compact") | {at, trigger, outcome, reason, cacheRead: .response.usage.cacheRead}' ~/.pi/agent/cached-compaction.jsonl
```

The log stays on your machine. A mismatch excerpt can include up to 200 characters of the conversation.

## What it costs

Pi's default compaction sends only the messages it summarizes, as text, and cuts each tool result to 2,000 characters. It pays full price for all of it. This extension sends the whole session and pays the cache-read price for nearly all of it. Which one costs less depends on what the session holds. Measured with GPT through opencode-go, at the prices in Pi's model catalog:

| Session at compaction | Pi default | pi-cached-compaction |
|---|---|---|
| 44k tokens, mostly tool output (`gpt-6-luna`) | 5.9k sent, $0.00090 | 44k sent, 99% cached, $0.00097 |
| 44k tokens, mostly tool output (`gpt-5.6-luna`) | 5.9k sent, $0.00189 | 45k sent, 99% cached, $0.00190 |
| 9k tokens, mostly long answers (`gpt-6-luna`) | 4.9k sent, $0.00087 | 8.8k sent, 94% cached, $0.00050 |
| 10k tokens, mostly long answers (`gpt-5.6-luna`) | 6.0k sent, $0.00224 | 10k sent, 95% cached, $0.00123 |
| 2k tokens, a few tool calls (`gpt-6-luna`) | 0.3k sent, $0.00009 | 2.2k sent, 83% cached, $0.00035 |

In tool-heavy sessions the two come out about even. The cached path's input cost less ($0.00049 against $0.00074 on `gpt-6-luna`), but the model reasoned longer over the full context. For the same price, the summary is written from the full tool output instead of 2,000-character excerpts. When the session is mostly conversation, the default sends all of it at full price, and this extension costs 42–45% less. In very small sessions the default is cheaper. In these runs Pi's default also paid OpenAI's 1.25× cache-write price; the opencode-go flag under [With OpenAI models](#with-openai-models) stops that.

## Cache timer and compacting before expiry

In interactive sessions the extension turns on Pi's long cache retention (`PI_CACHE_RETENTION=long`) unless you've set that variable yourself. Anthropic caches then last 1 hour instead of 5 minutes. Anthropic charges 2× input price to write a 1-hour cache instead of 1.25×, and reads cost the same. On GPT-5.6 and later, the system prompt and tools are cached for 12 hours instead: see [With OpenAI models](#with-openai-models). Headless runs (`pi -p`, JSON mode, subagent processes) keep the short cache, because nobody pauses there and the higher write price would be wasted.

On `pi-claude/*`, Claude Code picks the cache lifetime itself (1 hour on a subscription), so this setting doesn't apply there and `/cached-compaction` says so.

The choice is made once per session because a cache can't move up a tier cheaply. Measured through Claude Code on Anthropic:

```
 5m entry, then a 1h request   → full rewrite at 2×       (42,132 tokens written)
 1h entry, then a 5m request   → read as normal           (53,459 read, 67 written)
 idle 8 min on 5m              → expired, rewrite         (39,707 written)
 idle 8 min on 1h              → still warm
```

So "5 minutes while working, 1 hour when idle" costs more than choosing 1 hour from the start. With the 1-hour cache, Pi's own cache warmer rarely fires, which is fine: it stops after 30 idle minutes, before a 1-hour cache needs a refresh.

While Pi is idle, the footer shows how long the cache has left: `⏱ 42m`, then `⏱ 0:45`, turning to the warning color in the last 30 seconds and to `cache cold` once it expires. The lifetime comes from the cache tier the provider reports it wrote (Pi's Anthropic provider and pi-claude-bridge report it), else from the model's declared lifetime, else OpenAI's 30-minute minimum for GPT-5.6 and later. Other models show no countdown unless you declare a lifetime with Pi's `modelOverrides.promptCache`. In powerline-footer it shows in the `extension_statuses` segment.

By default, Pi compacts 20 seconds before the cache expires, but only when it's idle, nothing is queued, Pi's automatic compaction is on, the context holds at least `minContextTokens` tokens, and the cached path is available. Otherwise nothing happens. Sending a message resets the timer. The threshold is in tokens rather than percent because the cost of rewriting an expired cache depends on its size, and on 1M-token models a percentage would almost never trigger.

On `pi-claude/*` this saves no money: Claude Code bills by subscription, so the bridge prices its models at $0. What it saves is subscription quota and the slow first reply after a cold cache. It still replaces the older part of the conversation with a summary well before Pi would compact a 1M-token model, so raise `minContextTokens` or turn it off if you'd rather keep the full context through long pauses.

The settings live under `cachedCompaction` in `~/.pi/agent/settings.json`; project settings files don't apply to this key, and an unknown key is an error. The defaults are `cacheRetention: "long"`, `compactBeforeExpiry: true`, and `minContextTokens: 50000`. To stop compacting before expiry:

```json
{
  "cachedCompaction": {
    "compactBeforeExpiry": false
  }
}
```

## How it stays safe

Before anything is sent, the extension rebuilds the request with Pi's own serializer and compares it field by field with the last real request. If any part of the cached prefix would differ, it doesn't send its request and Pi's default compaction runs instead. That covers a different thinking level, an edited history, tree navigation, or a model switch.

```
 rebuild request ──► compare with last real request
                       ├─ identical prefix ──► send ✅
                       └─ any difference ───► send nothing
                                              └─► Pi's default compaction
```

It also steps aside when:

- the model's declared cache lifetime has passed since the last request or cache-warming refresh, or the last successful request didn't use the cache (for example, a prompt under the provider's minimum cacheable length). A cold cache makes the full prompt cost more than the default.
- compaction is recovering from a context overflow
- the first message Pi keeps has no text the summary prompt can point at (only an image or thinking), so the summary couldn't be told where to stop
- the provider builds no HTTP payload Pi can see (other than pi-claude-bridge, below)
- the API isn't a `messages` or `input` style payload (Anthropic, OpenAI Chat Completions, OpenAI Responses). Google isn't supported yet.

## With pi-claude-bridge

`pi-claude/*` models run in Claude Code, so there's no payload to compare. Instead, the extension sends the summary request with the bridge's `x-claude-bridge-fork: 1` header. The bridge runs it on a copy of the live Claude Code conversation, which reads its prompt cache, and deletes the copy afterwards. The live conversation is only read. If the bridge can't copy the conversation, it imports the history instead, and the card reports the missing cache hit.

Measured on `pi-claude/claude-haiku-4-5` after three turns: 10,793 of 11,437 prompt tokens came from the cache, the main Claude Code transcript was unchanged, and the copy was deleted. Claude Code reports a 1-hour cache on a subscription, so the countdown shows `⏱ 59m`. The request is also marked as a one-shot, so a bridge without fork support runs it apart from the live conversation: the summary still works, just without the cache hit.

## With OpenAI models

OpenAI caches the same way in principle: a matching prefix reads at 0.1× the input price (0.05× on GPT-6.1 Sol), and GPT-5.6 and later charge 1.25× to write it. OpenAI documents a minimum of 30 minutes for GPT-5.6 and later; for earlier models it says "typically 5 to 10 minutes" in memory, or about 30 minutes with 24-hour retention. What the extension does depends on the provider:

```
                    openai provider                  opencode-go
countdown           ⏱ 30m on GPT-5.6 and later       ⏱ 30m once you set the flag below
long retention      12h system prompt, 30m chat      the same with the flag; without it, Pi sends
                    one cache key per project        the older "24h" field, which does nothing
reasoning effort    GPT-6: item after the cache      request field: a thinking change falls back
tool_choice         "none" on the summary request    left alone
tested live         not yet (no API credits)         yes, see Live test results
```

**12 hours for what every session shares.** OpenAI lets one request mix cache lifetimes. With long retention on, the extension gives the system prompt a 12-hour breakpoint, which also covers the tool definitions OpenAI renders before it, and leaves the conversation on the 30-minute default. It also replaces Pi's per-session `prompt_cache_key` with one per project. OpenAI keeps caches under different keys apart, so with Pi's key every new session paid to write the same system prompt and tools again.

```
                        Pi alone                          with the extension
system prompt + tools   each session writes it at 1.25×   written once at 2.5×, kept 12 h,
                        and it lasts 30 min               read by later sessions at 0.1×
conversation            30 min                            30 min (the countdown follows this)
```

The 12-hour write costs an extra 1.25× of the prefix once, and the second session in the project that day earns it back. With a full set of extensions the prefix is around 19k tokens. Pi prices every cache write at the 30-minute rate, so its cost display understates the 12-hour part. The cached compaction request carries the same key and breakpoint, so its prefix still matches. Headless runs keep short retention, so they don't get this.

**opencode-go.** Pi doesn't send OpenAI's cache options to opencode-go's GPT models, so they get neither the 12-hour prefix nor a countdown. Turn the options on in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "opencode-go": {
      "modelOverrides": {
        "gpt-6-luna": { "compat": { "supportsExplicitPromptCacheMode": true } },
        "gpt-5.6-luna": { "compat": { "supportsExplicitPromptCacheMode": true } }
      }
    }
  }
}
```

Pi's own cache warmer only runs for models with a declared lifetime, so add `"promptCache": { "short": 1800, "long": 1800 }` next to `compat` if you want it to keep caches warm during long runs.

Measured through opencode-go:

- With the flag, a second session in the same project read 1,261 of 1,264 prompt tokens from the cache on its first request. With Pi's per-session key it read none.
- A 12-hour entry was still cached after 40 idle minutes, both as a breakpoint on the system prompt and as the request's lifetime. A 30-minute entry written at the same time had expired. These were direct API requests.
- With the flag, cached compaction still read 83–86% from the cache, the countdown showed `⏱ 29m`, and Pi's own compaction stopped writing to the cache (0 tokens, where it used to write its whole prompt at 1.25×).
- The conversation's 30-minute lifetime held: warm after 12, 17, and 24 idle minutes, gone after 32 and 62. `compactBeforeExpiry` and the fallback after expiry were tested with a 75-second declared lifetime (see Live test results).

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
| Second session in the same project, first request (flag on) | 1,261 of 1,264 cached; none with Pi's per-session key |
| 12-hour entry, idle 40 minutes (direct API requests) | still cached; a 30-minute entry beside it had expired |
| Tools, then `/compact` twice, with the flag (12h prefix, shared key) | 83, 85% / 84, 86%; countdown `⏱ 29m` |
| Pi's own compaction with the flag | 0 tokens written to the cache |

Every run that used tools left the edited file correct. Cost comparisons with Pi's default are in [What it costs](#what-it-costs).

## Limitations

- Outside the `openai` provider, the model sees your tools during the summary request and is told not to call them, because changing `tool_choice` costs cache there: on Anthropic it discards the message cache. If it calls a tool or replies with no summary text, Pi's default compaction runs.
- Without a known cache lifetime, the extension can't tell a cold cache from a warm one, so a compaction after a long pause pays to rewrite the whole session. Set the flag above for opencode-go's GPT models, or declare a lifetime with Pi's `modelOverrides.promptCache` for other models.
- Fields that extensions loaded before this one add to provider payloads, such as codex-fast's `service_tier`, are copied into the summary request. Changes from extensions loaded after it aren't seen, so the request can miss the cache. The summary is still correct, it just costs about what the default would, and the card shows the low cache share.
- When a later compaction falls back to Pi's default, its read and modified file lists start over: Pi doesn't carry the lists forward from an extension's compaction.
