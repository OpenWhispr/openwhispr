# Live CLI fixtures (Phase 8, plan 08-01)

Captured 2026-11-20 on the dev PC by `scripts/fork/capture-llm-cli-fixtures.mjs` using each CLI's own existing
subscription sign-in. No login was run, no token minted, no API key used. The prompt was `Reply with the single word OK`.
Every file passes `scrubFixture` (emails, UUIDs, tokens, JWTs, home paths, org and account ids). The policy module
changes to match these files, never the reverse. Refresh with:
`node --import tsx scripts/fork/capture-llm-cli-fixtures.mjs [--seat claude|codex|grok|agy]`.

| Seat           | Argv shape (from `buildRunArgv`)                                                                                                                                                       | Fixture file                         | Seconds | Outcome                     | Scrub applied                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude 2.1.330 | `-p --output-format stream-json --verbose --include-partial-messages --tools "" --strict-mcp-config --no-session-persistence --permission-mode dontAsk --model haiku`, prompt on stdin | `claude-stream.ndjson`               | 12.8    | ok                          | `scrubFixture` plus hook events dropped and `system` init/status reduced to type, subtype, model, session id (the raw stream carried this machine's hook output and tool inventory) |
| codex 0.157.0  | `exec --sandbox read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -o <file> -`, prompt on stdin                                                          | `codex-last-message.txt`             | 8.0     | ok                          | `scrubFixture`                                                                                                                                                                      |
| grok 1.0.70    | `--prompt-file <file> --output-format json --permission-mode dontAsk --no-subagents --max-turns 1`                                                                                     | `grok-json.txt` = `{"timeout":true}` | 31.7    | timeout (idle 30 s, killed) | n/a, no output                                                                                                                                                                      |
| agy 1.5.13     | `-p <prompt> --output-format json --print-timeout 115s`                                                                                                                                | `agy-json.txt`                       | 9.0     | ok                          | `scrubFixture` (conversation id)                                                                                                                                                    |

Notes:

- grok: the headless run hung with no output and was killed by the idle timeout. This is the known D-03 latency hang. The
  `{"timeout":true}` marker is the fixture, the policy classifies it (`timeout` in `ERROR_CODES`, `TIMEOUTS.idleMs`), and
  no workaround was added. Reported to AgentAutofix (annotation `c11db263-bb89-45b8-8c8d-2abab35cc11f`, repo slug
  `openwhispr`).
- agy answers with `{"conversation_id", "status", "response", ...}`, so `response` is the live text field.
- claude's `result` event closes the stream; text arrives as `stream_event` `content_block_delta` `text_delta` events.
- `--verify-only` confirms every `requiredFlags` entry of every seat is present in the installed CLI's `--help`.
- `grok models` and `agy models` listings were copied into the `models` arrays in `src/helpers/llmCliProviders.js`;
  codex exposes no model listing, so its array stays empty (the UI omits `-m`, CLI default).
