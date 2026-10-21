# pi-cached-compaction

Pi's built-in compaction sends the conversation to the model as a new request with its own system prompt, so it never reads the prompt cache your session just paid to build. This extension sends the summary request as the next turn of the same conversation instead. The provider then reads almost all of it from the cache, at about a tenth of the normal input price on Anthropic and OpenAI.

```
Pi default:   [summarizer prompt][conversation as plain text]    → full input price
this:         [same tools][same system prompt][same messages]   → cache read
              [+ "summarize everything above"]                   → small new tail
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

## How it stays safe

Before anything is sent, the extension rebuilds the request with Pi's own serializer and compares it field by field with the last real request. If any part of the cached prefix would differ, it doesn't send its request and Pi's default compaction runs instead. That covers a different thinking level, an edited history, tree navigation, or a model switch.

It also steps aside when:

- the model's declared cache lifetime has passed since the last request or cache-warming refresh, since a cold cache makes the full prompt cost more than the default
- compaction is recovering from a context overflow
- the provider doesn't build an HTTP payload Pi can see, such as the `pi-claude` Claude Code bridge
- the API isn't a `messages` or `input` style payload (Anthropic, OpenAI Chat Completions, OpenAI Responses). Google isn't supported yet.

## Limitations

- The model sees your tools during the summary request and is told not to call them. If it replies with no summary text, Pi's default compaction runs.
- If another extension rewrites provider payloads after this one, the request can miss the cache. The summary is still correct, it just costs about what the default would.
