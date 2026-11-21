---
phase: 06-hosted-services
plan: 04
status: partial
requirements: [FEAT-01, FEAT-02, FEAT-03]
depends_on: [06-01, 06-02, 06-03]
completed: 2026-11-20
prod_host: https://stt.titaniumlabs.us
deploy: "Coolify deployment xgi4idzkb1hny6prghtlazeb"
---

# Phase 6 Plan 04: Live production proof - PARTIAL

Server-side proof ran against production on 2026-11-20 after the Coolify deploy `xgi4idzkb1hny6prghtlazeb` of stt-api (host `https://stt.titaniumlabs.us`). The proofs that need our own OAuth clients (06-03, BLOCKED) did not run.

## Evidence

| Check | Command or probe | Result |
|-------|------------------|--------|
| Health | `GET /healthz` | 200 |
| Live streaming | `verify-stream-segments` against prod | PASS: 9 segments, close code 1000 |
| Cleanup chat | `verify-chat-completions` against prod | PASS: 200 |
| Web search (criterion 1, server half) | `POST /v1/agent/web-search` with a license key | 200 with results |
| OAuth relay, valid state | `GET /auth/slack/callback` and `/auth/linear/callback` with a valid `v1.<port>.<nonce>` state | 302 to the `127.0.0.1` loopback |
| OAuth relay, malformed state | same routes with a malformed state | 400 HTML page |

Criterion 2 (server half) is proven: the relay forwards a well-formed state to the loopback and rejects anything else.

## Not run

- `verify-http-api` and `verify-scribe`: local-engine gates (need `BIN_DIR`, whisper-server and an ElevenLabs key). They do not exercise prod, so they were not run against it, by design.
- Slack and Linear OAuth through the relay into the real auth modules (criterion 2, full): needs 06-03 clients.
- Google and Microsoft OAuth through the real calendar modules, and a signed fork build carrying the five client-id key names (criterion 3): needs 06-03 clients. Without them the v1.10.5 build shows Connect on the calendar rows without client ids.
- Packaged-app assistant turn that runs `web_search` (criterion 1, desktop half): not run in the packaged build.

## Status by requirement

- FEAT-01: server proven live; packaged-app turn not run.
- FEAT-02: relay proven live (302/400); end-to-end connect blocked on 06-03.
- FEAT-03: blocked on 06-03.
