# Live tests and measurements

The measurements behind the README. Run on 2026-10-21 with Pi 1.3.0 in RPC mode, with a logger recording each request's cache fields and the cache usage the provider reported.

## Compaction across models

Unless noted, a run makes three tool-using turns (read, edit, bash), runs `/compact`, makes one more edit, and runs `/compact` again. The percentage is the share of the summary request's prompt read from the cache. In these small sessions the summary instruction, about 350 new tokens, keeps it in the 80s: the summary request read everything the previous turn had sent except its last 3 tokens.

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

Every run that used tools left the edited file correct.

## GPT through opencode-go

`gpt-6-luna` / `gpt-5.6-luna`:

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
| An extension message arrived while idle, then `/compact` | cached, 1,510 of 1,513 from the cache |
| `tool_choice: "none"` on the summary request | 72 fewer tokens read from the cache, every time |
| Second session in the same project, first request (flag on) | 1,261 of 1,264 cached; none with Pi's per-session key |
| 12-hour entry, idle 40 minutes (direct API requests) | still cached; a 30-minute entry beside it had expired |
| Tools, then `/compact` twice, with the flag (12h prefix, shared key) | 83, 85% / 84, 86%; countdown `⏱ 29m` |
| Pi's own compaction with the flag | 0 tokens written to the cache |

More on the flag (`supportsExplicitPromptCacheMode`, see the README):

- With it, a second session in the same project read 1,261 of 1,264 prompt tokens from the cache on its first request. With Pi's per-session key it read none.
- A 12-hour entry was still cached after 40 idle minutes, both as a breakpoint on the system prompt and as the request's lifetime. A 30-minute entry written at the same time had expired. These were direct API requests.
- Cached compaction still read 83–86% from the cache, the countdown showed `⏱ 29m`, and Pi's own compaction stopped writing to the cache (0 tokens, where it used to write its whole prompt at 1.25×).
- The conversation's 30-minute lifetime held: warm after 12, 17, and 24 idle minutes, gone after 32 and 62.

## `tool_choice`

OpenAI's guide recommends `tool_choice: "none"` to stop tool calls without changing the cached prefix. Measured on GPT through opencode-go, it isn't quite free: the summary request read exactly 72 fewer tokens from the cache every time, at any session size. On Grok through opencode-go it cut the cache off after the tool definitions (62–69% instead of 90%). That's why the extension only sets it on the `openai` provider. No model called a tool in any test.

## Cache tiers through Claude Code

A cache can't move up a tier cheaply, which is why the retention is chosen once per session:

```
 5m entry, then a 1h request   → full rewrite at 2×       (42,132 tokens written)
 1h entry, then a 5m request   → read as normal           (53,459 read, 67 written)
 idle 8 min on 5m              → expired, rewrite         (39,707 written)
 idle 8 min on 1h              → still warm
```

So "5 minutes while working, 1 hour when idle" costs more than choosing 1 hour from the start. With the 1-hour cache, Pi's own cache warmer rarely fires, which is fine: it stops after 30 idle minutes, before a 1-hour cache needs a refresh.

## pi-claude-bridge

On `pi-claude/claude-haiku-4-5` after three turns: 10,793 of 11,437 prompt tokens came from the cache, the main Claude Code transcript was unchanged, and the copy was deleted. Claude Code reports a 1-hour cache on a subscription, so the countdown showed `⏱ 59m`.

## Not yet tested live

- The `openai` provider (no API credits). GPT-6 models there carry the reasoning effort as a trailing `configuration_update` item after the cache breakpoint, which the prefix check treats like Anthropic's trailing effort message. That path is checked against Pi's own OpenAI serializer for `gpt-6.1-sol` and `gpt-5.5`.
- `openai-codex` (ChatGPT sign-in).
