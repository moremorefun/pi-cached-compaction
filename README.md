# pi-cached-compaction

Pi compaction that reads the prompt cache your session already built.

```
 cached compaction  (ctrl+o for details)
 23:43:49 /compact: cached, 99% of 50k from cache, 2k out, 11.3s, summary 3263 chars
          vs Pi's compaction: 62% less, $0.0013 instead of ~$0.0035 (it sends ~27k tokens, none from cache)
 23:43:49   saved, 49k tokens summarized

 ──────────────────────────────────────────────────────────────────────────
 > _
 ──────────────────────────────────────────────────────────────────────────
 ~/my-project                                     ⏱ 29m · gpt-6-luna · medium
```

A real card from one of my test sessions: about 50k tokens of reading source files on `gpt-6-luna`. The footer counts down how long the cache has left.

## Why this exists

Pi's compaction swaps the system prompt, drops the tools, and flattens the messages into text. None of that matches what the provider has cached, so every token of the summary request is billed at full price.

I wrote this extension to keep all three as they are and append one instruction instead, as the next turn of the same conversation:

```
Pi's compaction        [summarizer prompt] [older messages as text, tool output cut]      nothing cached

pi-cached-compaction   [tools] [system prompt] [msg 1 … msg N] [summarize this]
                       └──── same bytes as your last turn ───┘ └──── new ────┘      ~99% cached
```

The provider reads nearly all of it from the cache at about a tenth of the input price, and the model writing the summary sees the whole conversation, tool output included. The result looks like Pi's: its checkpoint format, its window of recent messages kept as they are, and the read and modified file lists carried forward.

## vs Pi's compaction

- **Reads the cache.** About 99% of the summary request comes from the cache at normal compaction sizes.
- **Sees all the tool output.** Pi's compaction shows the model the first 2,000 characters of each tool result. This one shows all of it.
- **Compares itself with Pi's.** Each compaction gets a card showing its cost next to what Pi's compaction would have cost for the same messages.
- **Compacts before the cache expires.** If you step away, it compacts from the warm cache, so your next message doesn't pay to write the whole session again.
- **Falls back cleanly.** It checks that the request repeats your last one byte for byte up to the new part. When it can't prove that, Pi's own compaction runs as usual. (Claude through pi-claude-bridge is checked by the bridge instead; see [Providers](#providers).)

| | Pi's compaction | pi-cached-compaction |
|---|---|---|
| What it sends | the older messages as text, under its own system prompt | your conversation as it is, plus one instruction |
| Prompt cache | not used | about 99% read from it at normal compaction sizes |
| Tool output the summary sees | the first 2,000 characters of each result | all of it |
| Cost | full price, for the older messages only | 0.1× for the whole session: less once there's a lot to summarize, more on small sessions ([numbers](#what-it-costs)) |
| After a long break | your next message rewrites the whole expired cache | it compacts just before the cache expires, so there's much less to rewrite |
| Cache lifetime | Pi's default (5 minutes on Anthropic) | 1 hour in interactive sessions, which Anthropic bills at 2× per write instead of 1.25× ([why](#compacting-before-the-cache-expires)) |
| What you see | the summary | the summary, a card comparing the cost with Pi's compaction, and a cache countdown in the footer |

## Install

```bash
pi install git:github.com/nicobailon/pi-cached-compaction
```

Then run `/reload`. It needs Pi 0.87.0 or newer, and everything is on by default.

## What you'll see

**The card** at the top appears under the summary after each compaction. It's shown to you only, never sent to the model, and stays in the session after a resume. Its second line compares this compaction with what Pi's would have cost for the same messages: green when this one cost at least 5% less, amber when it cost at least 5% more, and "about the same" in between. Models with no price, like Claude Code's subscription models through pi-claude-bridge, get the comparison in tokens not read from the cache instead of dollars.

**Pi's side is an estimate,** since Pi's compaction never runs. The extension serializes the messages exactly as Pi's compaction would, then counts tokens at the rate the provider counted for this summary request, so it follows each model's tokenizer. In my tests it came within 2–12% of what Pi's compaction actually sent, always a little high. For the session above, Pi's compaction really cost $0.0032, so the true saving was 58% rather than 62%.

**When the cache can't be used,** the card says why and what Pi's compaction did instead. Expand it with ctrl+o to see what the decision rested on:

```
 cached compaction
 13:48:54 /compact: Pi's compaction, request field "reasoning" differs
          cache: lifetime 30 min (OpenAI's minimum), 30 min left
          last request: 4 s ago, 20 messages, 2k prompt tokens, 1 new since
          request: thinking low, shared 12h prefix
          last request had: {"effort":"high","summary":"auto"}
          summary request had: {"effort":"low","summary":"auto"}
 13:48:59   Pi's compaction saved: 0% of 923 from cache, 384 out, $0.0003, summary 1243 chars
 log: ~/.pi/agent/cached-compaction.jsonl
```

**The countdown** in the footer shows how long the cache has left. Sending a message restarts it, and it goes `⏱ 59m … ⏱ 2m … ⏱ 0:25` (in the warning color for the last 30 seconds), then `cache cold`. In powerline-footer it shows in the `extension_statuses` segment. The lifetime comes from the cache tier the provider reports writing (Anthropic and pi-claude-bridge report it), else the model's declared lifetime, else OpenAI's 30-minute minimum for GPT-5.6 and later. Models with none of those show no countdown.

**`/cached-compaction`** shows the cache right now, whether the next compaction would take the cached path, and this session's log:

```
pi-cached-compaction · opencode-go/gpt-6-luna
cache: ⏱ 29m left (lifetime 30 min, OpenAI's minimum)
next compaction: cached path; last request 4 s ago with 186 messages, 1 since. The request prefix is checked when it runs.
before expiry: on, from 50k tokens of context · retention long
log: ~/.pi/agent/cached-compaction.jsonl

This session:
23:43:49 /compact: cached, 99% of 50k from cache, 2k out, 11.3s, summary 3263 chars
         vs Pi's compaction: 62% less, $0.0013 instead of ~$0.0035 (it sends ~27k tokens, none from cache)
23:43:49   saved, 49k tokens summarized
```

**The log.** Every decision is also appended to `~/.pi/agent/cached-compaction.jsonl`, which moves to `.1` past 5 MB. Each line records what triggered the compaction, the path it took and why, the request settings, the provider's cache usage, the estimate for Pi's compaction, and the timing. When the request didn't match, it includes up to 200 characters of each version around the first difference. The log stays on your machine.

```sh
jq -c 'select(.event == "compact") | {at, trigger, outcome, reason, cacheRead: .response.usage.cacheRead, piEstimate}' ~/.pi/agent/cached-compaction.jsonl
```

## Common tasks

| Want | Do |
|---|---|
| See the cache now and this session's compactions | `/cached-compaction` |
| See why a compaction didn't use the cache | expand its card with ctrl+o |
| Stop compacting before the cache expires | `"compactBeforeExpiry": false` in [Settings](#settings) |
| Compact before expiry only on bigger sessions | raise `minContextTokens` |
| Keep Pi's 5-minute cache and its 1.25× writes on Anthropic | `"cacheRetention": "short"` |
| Get the countdown for GPT on opencode-go | `/cached-compaction cache-flag` (see [Providers](#providers)) |
| Get the countdown on another model | declare a lifetime with Pi's `modelOverrides.promptCache` |
| Look through past decisions | the `jq` line under [What you'll see](#what-youll-see) |

## Settings

Add a `cachedCompaction` key to `~/.pi/agent/settings.json`. Project settings files don't apply to this key, and an unknown key is an error.

| Setting | Default | What it does |
|---|---|---|
| `compactBeforeExpiry` | `true` | compact 20 s before the cache expires, when idle |
| `minContextTokens` | `50000` | the smallest context worth compacting before expiry |
| `cacheRetention` | `"long"` | ask for the longer cache in interactive sessions (2× writes on Anthropic); `"short"` keeps Pi's default |

```json
{
  "cachedCompaction": {
    "compactBeforeExpiry": false
  }
}
```

## Compacting before the cache expires

If you step away, the cache expires and your next message pays to write the whole session again. So 20 seconds before expiry, the extension compacts from the still-warm cache, and your next message rewrites a summary-sized context instead. It only does this when:

- Pi is idle with nothing queued,
- Pi's auto-compaction is on,
- the context holds at least 50k tokens (`minContextTokens`),
- and the cached path is available.

Otherwise it does nothing and the cache cools. Models without a [countdown](#what-youll-see) never compact before expiry.

The threshold is in tokens rather than percent because rewriting an expired cache costs in proportion to its size, and on 1M-token models a percentage would almost never trigger.

**The longer cache.** A 5-minute cache expires during most breaks, so in interactive sessions the extension asks for the longer one (`PI_CACHE_RETENTION=long`) unless you've set that variable yourself. That's 1 hour instead of 5 minutes on Anthropic, and a 12-hour shared system prompt on GPT-5.6 and later (see [Providers](#providers)). It isn't free on Anthropic: writing a 1-hour cache costs 2× the input price instead of 1.25×, though reads cost the same. Headless runs (`pi -p`, JSON mode, subagent processes) keep the short cache, since nobody pauses there. The choice is made once per session, because moving a cache up a tier means writing all of it again.

## Providers

| Provider | Cached compaction | Countdown and compact before expiry | Longer cache (interactive) |
|---|---|---|---|
| Claude via pi-claude-bridge | yes, on a copy of the Claude Code conversation | yes, 1 hour | Claude Code decides |
| Anthropic API | yes | yes, 1 hour | 1 hour instead of 5 minutes |
| Claude on opencode-go | yes | yes, 1 hour | 1 hour instead of 5 minutes |
| GPT-5.6+ on `openai` | yes, not tested live yet | yes, 30 minutes | 12-hour shared system prompt |
| GPT-5.6+ on opencode-go | yes | after `/cached-compaction cache-flag` (below) | after `cache-flag` |
| Other Responses and Chat Completions APIs | yes | only with a declared lifetime (`modelOverrides.promptCache`) | the provider's own |
| `openai-codex` (ChatGPT sign-in) | yes, not tested live yet | no, there's no documented lifetime | no |
| Google and others | no, Pi's compaction runs | no | no |

**Claude through pi-claude-bridge.** These models run in Claude Code, so there's no HTTP payload for the extension to compare. Instead it sends the summary request with the bridge's `x-claude-bridge-fork: 1` header. The bridge runs it on a temporary copy of the live Claude Code conversation, which reads its cache, and then deletes the copy. The live conversation is only read. A bridge without fork support runs the request as a one-shot: the summary still works without the cache hit, and the card shows that.

Claude Code bills by subscription, so the bridge prices these models at $0. Here, compacting before expiry saves subscription quota and the slow first reply after a cold cache, not money. It also replaces the older part of the conversation with a summary well before Pi would compact a 1M-token model. If you'd rather keep the full context through long breaks, raise `minContextTokens` or turn it off. Claude Code also picks its own cache lifetime (1 hour on a subscription), so `cacheRetention` doesn't apply.

**GPT-5.6 and later.** With the longer cache, the system prompt and tools get a 12-hour cache under one key per project, so later sessions in the same project read them instead of writing them again. The conversation keeps OpenAI's 30-minute cache, and that's what the countdown follows.

| | Pi alone | With the extension |
|---|---|---|
| System prompt and tools | each session writes them at 1.25×, and they last 30 minutes | written once at 2.5× and kept 12 hours; later sessions in the project read them at 0.1× |
| Conversation | 30 minutes | 30 minutes (the countdown follows this) |

The 12-hour write costs an extra 1.25× of that prefix once, and the second session in the project that day earns it back. With a full set of extensions the prefix is around 19k tokens. Pi prices every cache write at the 30-minute rate, so its cost display understates the 12-hour part.

**opencode-go.** Pi doesn't send OpenAI's cache options to opencode-go's GPT models, so they get no 12-hour prefix and no countdown until you turn the options on. Run `/cached-compaction cache-flag` and it adds them to `~/.pi/agent/models.json` for every opencode-go model that has them on `openai`, then switches the current session over. It rewrites the file as plain JSON, so if yours has comments it stops and you add this by hand:

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

## What it costs

Pi's compaction keeps the last 20k tokens as they are and sends only what's older, as text with each tool result cut to 2,000 characters, at full price. This extension sends the whole session and pays the cache-read price (0.1×) for nearly all of it. So on small sessions, and on sessions that mostly read big files, Pi's is often cheaper: it has little to send. Once the older part is most of the session, which is usually the case when auto-compaction fires, reading everything at 0.1× costs less. The card shows both numbers every time, so you can see which case you're in.

The part that isn't cached is the instruction (about 400–600 tokens, depending on the model) plus anything added since the last request. That stays about the same size, so the cached share grows with the session: in my tests 83% on a 2k-token session, 95% at 10k and 99% at 44k. For auto-compaction on a 200k model it works out to 99.7%. Auto-compaction can also fire in the middle of a run. Then the latest tool results are new too, but at that size they're still a small share.

What I measured with GPT through opencode-go, at the prices in Pi's model catalog:

| Session at compaction | Pi's compaction | pi-cached-compaction |
|---|---|---|
| 50k tokens, many small reads of source files (`gpt-6-luna`) | 26k sent, $0.0032 | 50k sent, 99% cached, $0.0013 |
| 44k tokens, ten whole docs read (`gpt-6-luna`) | 5.9k sent, $0.00090 | 44k sent, 99% cached, $0.00097 |
| 10k tokens, mostly long answers (`gpt-5.6-luna`) | 6.0k sent, $0.00224 | 10k sent, 95% cached, $0.00123 |
| 9k tokens, mostly long answers (`gpt-6-luna`) | 4.9k sent, $0.00087 | 8.8k sent, 94% cached, $0.00050 |
| 2k tokens, a few tool calls (`gpt-6-luna`) | 0.3k sent, $0.00009 | 2.2k sent, 83% cached, $0.00035 |

Where the two cost about the same, the difference is in what the summary was written from: the full tool output instead of 2,000-character excerpts.

## How it works

`/compact`, Pi's automatic compaction, and compacting before expiry all go through the same checks. The cached path is taken only when all four hold:

1. Same model as the last request, and the conversation only grew since then. New messages and extension notices are fine. Edits, `/tree`, a model switch, or a context overflow are not.
2. The last request used the cache, and the cache hasn't expired.
3. The instruction can quote where the kept messages start (below).
4. The rebuilt request is identical to the last one up to the new part. This runs on the exact request Pi would send, using Pi's own serializer, so a different thinking level (on most models), an edited message, or a field another extension changed all count. Nothing is sent when it fails.

If any check fails, Pi's own compaction runs. When compacting before expiry, nothing runs and the cache cools.

**Where the summary stops.** Pi keeps about the last 20k tokens of messages (its `keepRecentTokens` setting) word for word after the summary. The extension uses Pi's own cut point, so the summary has to stop where those messages begin. But the model reads the kept messages too, since they're part of the cached conversation:

```
 msg 1 … msg K-1           msg K … msg N              + "Summarize what comes before the
 └── summarized ──┘        └── Pi keeps these ──┘        message starting with: <msg K>"
```

So the instruction quotes the first kept message as the model sees it (and says which repeat it is, if that text appears more than once), says how many messages are kept, and tells the model to write the summary as if the conversation ended before the quoted one. In my repeated tests where Pi's cut fell in the middle of a turn, no summary reported kept work as done. If the first kept message has nothing to quote (only an image, or only thinking), it doesn't guess: Pi's own compaction runs.

**Tools during the summary.** On the `openai` provider, the summary request sets `tool_choice: "none"`, which OpenAI keeps out of the cached prefix. Elsewhere changing it costs cache (on Anthropic it drops the message cache), so the model sees your tools and is told not to call them. If it calls one anyway, Pi's own compaction runs. In my tests no model tried.

## Limitations

- Without a known cache lifetime, the extension can't tell a cold cache from a warm one. A compaction after a long break then pays to rewrite the whole session. Declare a lifetime with Pi's `modelOverrides.promptCache`, or, for GPT on opencode-go, run `/cached-compaction cache-flag`.
- Through pi-claude-bridge the extension can't check the request. If the bridge can't copy the whole Claude Code conversation, the summary is still correct but reads less from the cache, and the card shows the low cache share.
- Fields that extensions loaded before this one add to provider requests are copied into the summary request, such as codex-fast's `service_tier`. Changes from extensions loaded after it aren't seen, so the request can miss the cache. The summary is still correct, it just costs about what Pi's compaction would, and the card shows the low cache share.
- When a later compaction falls back to Pi's own, its read and modified file lists start over. Pi doesn't carry the lists forward from an extension's compaction.
- Right after a compaction, the card is the session's last entry. A second `/compact` then says "Nothing to compact (session too small)" instead of "Already compacted". Both mean there's nothing new to compact.

## Documentation

[docs/live-tests.md](docs/live-tests.md) has every test run behind the numbers here: the cache share on each model, how close the card's estimate of Pi's compaction came, where the summary stops when Pi's cut falls mid-turn, Claude and GPT through opencode-go, and cache tiers through Claude Code.
