# pi-cached-compaction

Pi's compaction starts a fresh request, so it can't read the prompt cache your session already paid to build. This extension asks for the summary as the next turn of the same conversation instead. The provider reads almost all of it from the cache, at about a tenth of the input price, and the summary is written from the full conversation.

| | Pi's compaction | pi-cached-compaction |
|---|---|---|
| What it sends | the old messages as text, under its own system prompt | your conversation unchanged, plus one instruction |
| Prompt cache | not used: every token at full price | about 99% read from the cache at normal compaction sizes ([less on tiny sessions](#what-it-costs)), at about 0.1× the price |
| Tool output the summary sees | cut to 2,000 characters | complete |
| Cost | full price for a trimmed copy | 42–45% less on chatty sessions, about even on tool-heavy ones, more on tiny ones ([measured](#what-it-costs)) |
| After a long break | your next message rewrites the whole expired cache | it compacts just before the cache expires, so your next message rewrites a much smaller context |
| What you see | the summary | the summary, a card with the path taken, cache share, and cost, and a cache countdown in the footer |

It never sends a request it can't prove will hit the cache. When it can't, Pi's own compaction runs as usual.

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
 cache:   ✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓·  ~99% hit at ~0.1×
 sees:    the full conversation, tools included, nothing cut

━━━━━━━━━━━━━━━━━━━━━━━━━  RESULT (same for both)  ━━━━━━━━━━━━━━━━━━━━━━━━━

 ┌──────────┬──────────┬───────────────────────────┐
 │ system   │ SUMMARY  │ recent msgs kept verbatim │
 └──────────┴──────────┴───────────────────────────┘
```

The summary uses Pi's checkpoint format, keeps Pi's recent-message window, and carries the read and modified file lists forward like Pi does.

## Install

Put this folder in `~/.pi/agent/extensions/pi-cached-compaction` (or install it as a Pi package), then `/reload`. It needs Pi 0.87.0 or newer. Everything is on by default; see [Settings](#settings) to change it.

## How it decides

Every compaction goes through the same checks: `/compact`, Pi's automatic compaction, and compacting before the cache expires.

```
 /compact · auto-compaction · 20 s before the cache expires
        │
        ▼
 same model, and the conversation only grew since the last request? ──no──┐
 (new messages and extension notices are fine; edits, /tree, a model      │
  switch, or a context overflow are not)                                  │
        │yes                                                              │
        ▼                                                                 │
 the last request used the cache, and it hasn't expired? ─────────no──────┤
        │yes                                                              │
        ▼                                                                 │
 can the instruction quote where the kept messages start? ────────no──────┤
        │yes                                                              │
        ▼                                                                 │
 rebuilt request identical to the last one, up to the new part? ──no──────┤
        │yes                                                  nothing sent│
        ▼                                                                 ▼
 send it: ~99% read from the cache                    Pi's own compaction runs
        │                                             (or, before expiry: nothing
        ▼                                              happens and the cache cools)
 a card in the chat shows the path taken, the cache share, and the cost
```

The comparison runs on the exact request Pi would send, using Pi's own serializer. Anything that would change the cached part means nothing is sent: on most models a different thinking level, and also an edited message or a field another extension changed.

Pi keeps about the last 20k tokens of messages (its `keepRecentTokens` setting) word for word after the summary. The extension uses Pi's own cut point, so the summary has to stop where those messages begin. The instruction quotes the first kept message as the model sees it, and if that text repeats, it also says which repeat it is:

```
 sent to the model (cached)                                        new
 ┌──────────────────────────────┬─────────────────────────────┬────────────────────┐
 │ msg 1 … msg K-1              │ msg K … msg N               │ "Summarize what    │
 │                              │                             │  comes before the  │
 │ ◄── summarized ──►           │ ◄── Pi keeps these as is ──►│  message starting  │
 │                              │                             │  with: <msg K>"    │
 └──────────────────────────────┴─────────────────────────────┴────────────────────┘
```

The model still reads the kept messages, since they're part of the cached prefix. In the live tests the summaries stopped at the quoted message and didn't repeat what came after it.

If the first kept message has nothing to quote (only an image, or only thinking), it doesn't guess: Pi's own compaction runs.

## Cache countdown and compacting before expiry

While Pi is idle, the footer counts down how long the cache has left. Just before it expires, the extension compacts from the still-warm cache, so your next message rewrites a summary-sized context instead of the whole session at full price.

```
 footer while idle:  ⏱ 59m … ⏱ 2m … ⏱ 0:45 (warning color) … cache cold

 last reply                                                cache expires
     │                                                           │
     ▼                                                           ▼
     ├──────────────────────────────────────────────────┬────────┤
                                                        │
                                             20 s before expiry
                                                        │
                    idle, nothing queued, Pi's auto-compaction on,
                    at least 50k tokens of context, cached path available?
                          │yes                                 │no
                          ▼                                    ▼
                compact while the cache is warm          do nothing
                (the card shows the result)

 sending a message at any point restarts the countdown
```

The threshold is in tokens rather than percent: rewriting an expired cache costs in proportion to its size, and on 1M-token models a percentage would almost never trigger. In powerline-footer the countdown shows in the `extension_statuses` segment.

The lifetime comes from the cache tier the provider reports it wrote (Anthropic and pi-claude-bridge report it), else the model's declared lifetime, else OpenAI's 30-minute minimum for GPT-5.6 and later. Models with none of those show no countdown and never compact before expiry. You can declare a lifetime with Pi's `modelOverrides.promptCache`.

In interactive sessions the extension also asks for the longer cache (`PI_CACHE_RETENTION=long`) unless you've set that variable yourself: 1 hour instead of 5 minutes on Anthropic, and a 12-hour shared system prompt on GPT-5.6 and later (see [Providers](#providers)). Anthropic charges 2× the input price to write a 1-hour cache instead of 1.25×, and reads cost the same. Headless runs (`pi -p`, JSON mode, subagent processes) keep the short cache, because nobody pauses there. The choice is made once per session, because a cache can't move up a tier without a full rewrite.

## Providers

```
                              cached        countdown and            longer cache
                              compaction    compact before expiry    (interactive)
 ───────────────────────────  ────────────  ───────────────────────  ──────────────────────────
 Claude via pi-claude-bridge  ✓ (fork)      ✓ 1 h                    Claude Code decides
 Anthropic API                ✓             ✓ 1 h                    1 h instead of 5 min
 GPT-5.6+ on openai           ✓ ¹           ✓ 30 min                 12 h shared system prompt
 GPT-5.6+ on opencode-go      ✓             ✓ with the flag ²        the same, with the flag ²
 other Responses and          ✓             with a declared          the provider's own
   Chat Completions APIs                    lifetime only ³
 openai-codex (ChatGPT)       ✓ ¹           ✗ no documented lifetime ✗
 Google and others            ✗ Pi's own compaction runs

 ¹ not tested live yet   ² see opencode-go below   ³ Pi's modelOverrides.promptCache
```

**Claude through pi-claude-bridge.** These models run in Claude Code, so there's no HTTP payload to compare. Instead, the extension sends the summary request with the bridge's `x-claude-bridge-fork: 1` header. The bridge runs it on a temporary copy of the live Claude Code conversation, which reads its cache, and then deletes the copy. The live conversation is only read. A bridge without fork support runs the request as a one-shot: the summary still works without the cache hit, and the card shows that.

Claude Code bills by subscription, so the bridge prices these models at $0. Here, compacting before expiry saves subscription quota and the slow first reply after a cold cache, not money. It also replaces the older part of the conversation with a summary well before Pi would compact a 1M-token model. If you'd rather keep the full context through long breaks, raise `minContextTokens` or turn it off. Claude Code also picks its own cache lifetime (1 hour on a subscription), so `cacheRetention` doesn't apply.

**GPT-5.6 and later.** With the longer cache, the system prompt and tools get a 12-hour cache under one key per project, so later sessions in the same project read them instead of writing them again. The conversation keeps OpenAI's 30-minute cache, and that's what the countdown follows.

```
                        Pi alone                          with the extension
system prompt + tools   each session writes it at 1.25×   written once at 2.5×, kept 12 h,
                        and it lasts 30 min               read by later sessions at 0.1×
conversation            30 min                            30 min (the countdown follows this)
```

The 12-hour write costs an extra 1.25× of that prefix once. The second session in the project that day earns it back. With a full set of extensions the prefix is around 19k tokens. Pi prices every cache write at the 30-minute rate, so its cost display understates the 12-hour part.

**opencode-go.** Pi doesn't send OpenAI's cache options to opencode-go's GPT models, so they get no 12-hour prefix and no countdown until you turn the options on in `~/.pi/agent/models.json`:

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

Pi's own cache warmer only runs for models with a declared lifetime. If you want it to keep caches warm during long runs, add `"promptCache": { "short": 1800, "long": 1800 }` next to `compat`.

**Tools during the summary.** On the `openai` provider, the summary request sets `tool_choice: "none"`, which OpenAI keeps out of the cached prefix. Elsewhere, changing it costs cache (on Anthropic it drops the message cache), so the model sees your tools and is told not to call them. If it calls one anyway, Pi's own compaction runs.

## What you'll see

After each compaction, a card appears below the summary. It's shown to you only and never sent to the model, and it stays in the session after a resume. These examples come from a 2k-token test session, which is why they show 83%:

```
cached compaction  (ctrl+o for details)
13:48:46 /compact: cached, 83% of 2k from cache, 405 out, $0.0003 (last turn sent 2k), 5.4s, summary 634 chars
13:48:46   saved, 2k tokens summarized
```

When it couldn't prove a cache hit, the card says why and what Pi's own compaction did instead. Expand it with ctrl+o to see what the decision rested on:

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

`/cached-compaction` shows the cache right now, whether the next compaction would take the cached path, and this session's log:

```
pi-cached-compaction · opencode-go/gpt-6-luna
cache: ⏱ 29m left (lifetime 30 min, OpenAI's minimum)
next compaction: cached path; last request 4 s ago with 14 messages, 1 since. The request prefix is checked when it runs.
before expiry: on, from 50k tokens of context · retention long
log: ~/.pi/agent/cached-compaction.jsonl

This session:
11:48:34 /compact: cached, 83% of 2k from cache, 405 out, $0.0003 (last turn sent 2k), 4.8s, summary 669 chars
11:48:34   saved, 2k tokens summarized
11:52:37 cache expires in 20s: not compacting, the context holds 2k tokens, under minContextTokens (50k)
```

Every decision is also appended to `~/.pi/agent/cached-compaction.jsonl`, which moves to `.1` past 5 MB. Each line records what triggered the compaction, each check's result, the request settings, the provider's cache usage, and the timing. When the request didn't match, it includes up to 200 characters of each version around the first difference. The log stays on your machine.

```sh
jq -c 'select(.event == "compact") | {at, trigger, outcome, reason, cacheRead: .response.usage.cacheRead}' ~/.pi/agent/cached-compaction.jsonl
```

## Settings

Everything is on by default. To change it, add a `cachedCompaction` key to `~/.pi/agent/settings.json`. Project settings files don't apply to this key, and an unknown key is an error.

| Setting | Default | What it does |
|---|---|---|
| `compactBeforeExpiry` | `true` | compact 20 s before the cache expires, when idle |
| `minContextTokens` | `50000` | the smallest context worth compacting before expiry |
| `cacheRetention` | `"long"` | ask for the longer cache in interactive sessions; `"short"` keeps Pi's default |

To stop compacting before expiry:

```json
{
  "cachedCompaction": {
    "compactBeforeExpiry": false
  }
}
```

## What it costs

Pi's compaction sends only the messages it summarizes, and pays full price for them. This extension sends the whole session and pays the cache-read price for nearly all of it.

The only part that isn't cached is the instruction (about 350 tokens) plus anything added since the last request. That part stays about the same size, so the cached share grows with the session. The tests below ran on small sessions to keep them cheap, which is where the lower numbers come from:

```
 summary request = everything your last turn sent  +  instruction (~350 tokens)
                   └──── read from the cache ───┘     └─── new, full price ───┘

 2k test session        █████████████████▒▒▒   83%    measured
 10k session            ███████████████████▒   95%    measured
 44k session            ████████████████████   99%    measured
 auto-compaction on a   ████████████████████   99.8%  computed: 350 new tokens
   200k model (~184k)                                  out of ~184k
                        █ from the cache  ▒ new
```

Auto-compaction can also fire in the middle of a run. Then the latest tool results are new too, but at that size they're still a small share.

Which costs less depends on what the session holds. Measured with GPT through opencode-go, at the prices in Pi's model catalog:

| Session at compaction | Pi's compaction | pi-cached-compaction |
|---|---|---|
| 44k tokens, mostly tool output (`gpt-6-luna`) | 5.9k sent, $0.00090 | 44k sent, 99% cached, $0.00097 |
| 9k tokens, mostly long answers (`gpt-6-luna`) | 4.9k sent, $0.00087 | 8.8k sent, 94% cached, $0.00050 |
| 10k tokens, mostly long answers (`gpt-5.6-luna`) | 6.0k sent, $0.00224 | 10k sent, 95% cached, $0.00123 |
| 2k tokens, a few tool calls (`gpt-6-luna`) | 0.3k sent, $0.00009 | 2.2k sent, 83% cached, $0.00035 |

In tool-heavy sessions the two cost about the same, but this summary is written from the full tool output instead of 2,000-character excerpts. In sessions that are mostly conversation it costs 42–45% less. In very small sessions Pi's compaction is cheaper. Every test run and measurement is in [docs/live-tests.md](docs/live-tests.md).

## Limitations

- Without a known cache lifetime, the extension can't tell a cold cache from a warm one. A compaction after a long break then pays to rewrite the whole session. Declare a lifetime with Pi's `modelOverrides.promptCache`, or set the opencode-go flag above.
- Fields that extensions loaded before this one add to provider requests are copied into the summary request. One example is codex-fast's `service_tier`. Changes from extensions loaded after it aren't seen, so the request can miss the cache. The summary is still correct, it just costs about what Pi's compaction would, and the card shows the low cache share.
- When a later compaction falls back to Pi's own, its read and modified file lists start over. Pi doesn't carry the lists forward from an extension's compaction.
- Right after a compaction, the card is the session's last entry. A second `/compact` then says "Nothing to compact (session too small)" instead of "Already compacted". Both mean there's nothing new to compact.
