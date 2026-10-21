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
Cached compaction: 182k of 190k prompt tokens came from the cache.
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

## Cache timer and compacting before expiry

The extension turns on Pi's long cache retention (`PI_CACHE_RETENTION=long`) unless you've set that variable yourself. Anthropic caches then last 1 hour instead of 5 minutes, and OpenAI caches 24 hours. Anthropic charges 2× input price to write a 1-hour cache instead of 1.25×, and reads cost the same.

While Pi is idle, the footer shows how long the cache has left: `⏱ 42m`, then `⏱ 0:45`, turning to the warning color in the last 30 seconds and to `cache cold` once it expires. The countdown needs a model that declares its cache lifetime, which today means Pi's built-in Anthropic models. In powerline-footer it shows in the `extension_statuses` segment.

With `compactBeforeExpiry` on, Pi compacts 20 seconds before the cache expires, but only when it's idle, nothing is queued, the context is at least `minContextPercent` full, and the cached path is available. Otherwise nothing happens. Sending a message resets the timer.

```json
{
  "cachedCompaction": {
    "cacheRetention": "long",
    "compactBeforeExpiry": true,
    "minContextPercent": 50
  }
}
```

Put this in `~/.pi/agent/settings.json`. The defaults are `"long"`, `false`, and `50`.

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
- the provider doesn't build an HTTP payload Pi can see, such as the `pi-claude` Claude Code bridge
- the API isn't a `messages` or `input` style payload (Anthropic, OpenAI Chat Completions, OpenAI Responses). Google isn't supported yet.

## Limitations

- The model sees your tools during the summary request and is told not to call them. If it replies with no summary text, Pi's default compaction runs.
- If another extension rewrites provider payloads after this one, the request can miss the cache. The summary is still correct, it just costs about what the default would.
