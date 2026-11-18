# Phase 5: Self-hosted transcription parity - Context

**Gathered:** 2026-11-18
**Status:** Ready for planning (auto-decided by the GSD planner; no human questions asked)
**Requirements:** STT-05, STT-06, STT-07
**Milestone:** TIWH v1.0

<domain>
## Phase Boundary

Meetings (Note Recording), the live dictation preview, file uploads and dictation cleanup all run on our own
server (openwhispr-stt-api on Coolify) for a signed-in user, with no BYOK provider key.

Success criteria (from the brief):
1. A meeting records with a live transcript streamed from the stt-api WebSocket.
2. An uploaded file gets timestamps and speaker labels.
3. Cleanup runs through stt-api by default when the user is signed in.

Two repos are touched. Each gets its own plan:
- `05-01-PLAN.md` - server, repo `finedesignz/openwhispr-stt-api` (local `C:\Users\artic\GitHub\edgeassistant-openwhispr-stt-api`).
- `05-02-PLAN.md` - desktop app, repo `finedesignz/openwhispr` (this repo).

Gap-analysis items closed: P14 (no meeting WS client for our server), P15 (uploads to our server lose timestamps
and speakers), P16 (no cleanup default on our server).
</domain>

<live_state>
## Live state verified 2026-11-18 (tool evidence, this session)

- `curl https://x1gsjcjrmssitgnh7hthg7nd.coolify.titaniumlabs.us/healthz`:
  - `status: ok`, but `engines.offline` (parakeet-unified-en-0.6b) `state: error`, live 0, free 0,
    `respawn_failures_total: 23400`, `crashes_total: 0`, binary and weights present. Batch transcription on prod
    is down. AgentAutofix ticket `c0533c8f-5330-4199-b39b-9e8f0b420bd9` (repo finedesignz/openwhispr-stt-api).
  - No `engines.online` entry: WebSocket streaming is not configured on prod (route answers 404
    "streaming is not configured").
  - `cleanup` ready (haiku via Claude CLI subscription OAuth, token valid to 2027-08-20).
  - `diarization` enabled and available.
- `/v1/models` without a bearer returns 401.
- `stt.titaniumlabs.us` and `stt-api.titaniumlabs.us` do not resolve (HTTP 000). The Coolify hostname is the only
  endpoint (stable domain is STT-03, another phase).
- stt-api `origin/main` is ecdd53f. The local stt-api checkout is 12 commits behind (7e8d695). Executors work from
  a fresh worktree of `origin/main`.
- Desktop `main` (726a7931d) already has: PR #10/#11 (phases 1-4), PR #12 (BRAND_NAME "EdgeAssistant"), the
  Titanium license bearer (`titaniumServiceKeyFor`), and stt-api PR #26 (license bearer accepted server side).
  `.planning/STATE.md` and `ROADMAP.md` are stale about this.
</live_state>

<decisions>
## Implementation Decisions (LOCKED)

### D-01: One plan per repo, server first
- 05-01 (stt-api) is wave 1. 05-02 (desktop) is wave 2 and depends on 05-01 for the wire contracts (segment
  frames, `/v1/chat/completions`, Scribe response shape).
- 05-02's build tasks test against local mock servers that implement the 05-01 contracts. Only its last task
  touches prod.
- Each plan ends with a separate "prove against prod" task. It runs only after its preconditions (deploy healthy,
  credential available) are checked live. Build and prove are never in the same task.
- Rationale: the brief asked for one plan per repo. The server contracts must exist before the desktop can wire
  to them, and a mock server lets the desktop build proceed while prod capacity is resolved.

### D-02: Streaming segments over the existing WS, opt-in by subprotocol (STT-05)
- Today the stt-api WS sends cumulative `partial` text and one `final` on finish. A meeting needs finalized
  segments as they happen (a 60-minute meeting cannot wait for `finish`).
- The client opts in with the WebSocket subprotocol `stt-segments` (`Sec-WebSocket-Protocol` header). With it,
  the server adds frames `{"type":"segment","index":<sherpa segment id>,"text":"...","final":<bool>}`, built from
  the sherpa online server's `segment` / `is_final` fields. `final:false` frames update the open segment;
  `final:true` closes it. The existing `partial` and `final` frames are still sent.
- Without the subprotocol, server behavior is byte-identical to today (existing tests stay green unmodified).
- Rejected: a query parameter (the route refuses any query, by design, to keep tokens out of logs) and a new
  client text frame (the route rejects any text frame other than `finish`; changing that widens the protocol
  surface for every client).
- Rationale: smallest server diff, fully backward compatible, and the desktop reducer already models per-source
  partial and final events.

### D-03: OpenAI-compatible cleanup endpoint `POST /v1/chat/completions` (STT-07)
- Same authorizer as every other route (operator token or Titanium license bearer).
- Accepts `messages` = exactly one `system` and one `user` message, both string content. Optional
  `temperature`, `max_tokens`, `max_completion_tokens` (clamped to the server maximum). `model` is accepted and
  ignored: the model is pinned to the configured cleanup model.
- Rejects with 400 `invalid_request`: `tools`, `functions`, `tool_choice`, array or image content, `stream: true`,
  `n > 1`, any other role layout. Total input capped at 32,000 characters (400 `input_too_long`).
- 503 `cleanup_not_configured` when cleanup is not configured, mirroring `/healthz`.
- Implementation: a new `claudeCli.complete({ system, user, signal })` that runs the CLI with the caller's system
  prompt, through the same concurrency limit and timeout (180 s) as in-band cleanup, and with the same
  tool-free CLI restrictions (see T-05-06).
- Response shape: `{ id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role:
  "assistant", content }, finish_reason: "stop" }] }`.
- Rejected: in-band `cleanup=true` on the transcription POST (loses the desktop's custom prompt, dictionary and
  agent-name handling; batch only) and a bespoke `/v1/cleanup` route (would need changes at the seven
  `isCloudCleanupMode` sites in hot upstream files instead of reusing the existing Custom provider).
- Rationale: the desktop already speaks OpenAI chat completions through the Custom cleanup provider, so the
  desktop change shrinks to defaults plus the key.

### D-04: Cleanup default = Custom provider pointed at our server (STT-07)
- Fork defaults (in `src/config/forkDefaults.ts`, consumed by `settingsStore.ts`) set, only when the user has no
  stored value: `cleanupProvider: "custom"`, `cleanupCloudBaseUrl: "<DEFAULT_STT.baseUrl>/chat/completions"`
  (a full path, so `getEndpointCandidates` goes straight to chat completions and never probes `/responses`), and
  `cleanupModel: "haiku"` (display only; the server pins the model).
- `ReasoningService.getApiKey("custom")`: when no stored cleanup key exists, it asks main for
  `getTitaniumServiceKey(cleanupCloudBaseUrl)`. Main's existing host gating means the license only ever goes to
  our hosts.
- `isAvailable()`: Custom pointed at a Titanium host with no stored key and no license returns false, so a
  signed-out user gets raw dictation text with no failing request (no 401 loop).
- Rationale: mirrors the existing STT key fallback in `audioManager.js` (custom STT key missing ->
  `getTitaniumServiceKey`), keeps one auth model across all our services.

### D-05: Meetings use a new stt-api streaming client, reached through the "self-hosted" mode (STT-05)
- New `src/helpers/sttApiStreaming.js` with the same interface as `deepgramStreaming.js` (callbacks
  `onPartialTranscript`, `onFinalTranscript`, `onError`, `onSessionEnd`, `onConnectionLost`; methods
  `connect`, `sendAudio`, `finalize`, `disconnect`, `cleanup`, `cleanupAll`, `getStatus`, `warmup`).
- Pure, Electron-free policy module `src/helpers/sttApiStreamPolicy.js` (fork-owned) holds: stream URL builder
  (`https` -> `wss`, path `/v1/transcriptions/stream`, `ws://` allowed only for loopback hosts), server-frame
  parser, and a stateful PCM16 resampler (24 kHz meeting audio -> 16 kHz, continuous across chunks).
- Segment frames: `final:false` -> `onPartialTranscript`, `final:true` -> `onFinalTranscript`. `finish` is sent on
  stop; the closing `final` frame is not re-emitted as a segment.
- Registered as provider `stt-api-realtime` in `STREAM_CLIENT_BY_PROVIDER`, so `ALLOWED_MEETING_PROVIDERS` admits
  it. The connection key comes from `titaniumServiceKeyFor(streamUrl)` in main, never from saved BYOK keys.
- Routing: `resolveMeetingTranscriptionOptions` today throws `unsupportedSelfHosted` for mode `self-hosted`
  (which is what the fork's dictation default carries into Note Recording). It now returns
  `{ provider: "stt-api-realtime", mode: "self-hosted", baseUrl, language }` when the self-hosted base URL is a
  Titanium service host (a boolean computed by the caller, keeping the function pure). Any other self-hosted URL
  still throws `unsupportedSelfHosted`, unchanged.
- Signed out on our host: prepare fails with the sentinel `signInRequired`, translated by the Note Recording
  mount into a new i18n message (all 9 locales, BRAND_NAME interpolated).
- Rationale: no new transcription mode, no settings migration, and the fork's existing dictation default
  (Custom -> our server) carries meetings onto our server automatically.

### D-06: Live dictation preview over the stt-api WS; committed text stays on the batch POST (STT-05)
- When dictation routes Custom -> a Titanium host and `showTranscriptionPreview` is on, the renderer starts the
  existing 16 kHz preview worklet and main opens an stt-api stream (no subprotocol; cumulative `partial` text ->
  `showTranscriptionPreview`, replacing the text).
- The committed transcript keeps using the existing batch POST (the offline model is more accurate than the
  streaming model). No streaming commit on our server.
- A preview stream that fails or is refused ends the preview (warn log) and leaves the dictation itself
  untouched. There is no second preview path (owner rule 7c).
- Rationale: preview parity with the smallest change to the hot `audioManager.js` gating and no change to the
  commit path.

### D-07: Uploads to our server use the Scribe route for timestamps and speakers (STT-06)
- `transcribe-audio-file-byok`, when the route is Custom to a Titanium host and the user asked for `diarize` or
  `timestamps`, posts to `<base>/speech-to-text` with `model_id`, `diarize` (`true`/`false`),
  `timestamps_granularity=word`, and no `language_code` (the server pins its language and rejects a mismatch).
- New pure module `src/helpers/scribeSegments.js` maps Scribe `words[]` to segments: consecutive `type:"word"`
  entries grouped by `speaker_id`, a new segment on speaker change, on a gap over 1.5 s, or after sentence-final
  punctuation once the segment exceeds 30 s. Output `{ speaker, text, start, end }`.
- Return shapes are the ones the handler already produces (diarized: formatted text plus segments; timestamps
  only: `{ success, text, segments }`), so the renderer is unchanged. Speaker ids map to the existing display
  labels the Mistral/OpenAI branch uses.
- Uploads without `diarize`/`timestamps` keep the existing `/v1/audio/transcriptions` POST.
- Rationale: the Scribe route already exists on the server with diarization and word timestamps; only the
  desktop routing and mapping are missing.

### D-08: Credential handling
- The license key is only sent in the `Authorization` header (WS upgrade and HTTP), never in a URL, never
  logged. All three paths reuse `titaniumServiceKeyFor` host gating; no new key-selection logic.
- Server proofs use the operator `STT_API_TOKEN` read from Coolify env into a process variable (never printed;
  compared by sha256 prefix only if comparison is needed).

### D-09: Streaming model on prod
- Prod `STT_STREAM_MODEL` = `nemotron-speech-streaming-en-0.6b` (English, cache-aware streaming, about 632 MB),
  matching the English offline default `parakeet-unified-en-0.6b`. `STT_STREAM_LANGUAGE` = `en`.
- The executor confirms the id against the allowed-model validation in `api/config.js` before setting it.
- Rationale: same language coverage as the batch default; smallest RAM footprint of the online models.

### Claude's Discretion (applied)
- Segment split thresholds in D-07 (1.5 s gap, 30 s sentence split) are chosen to match the readability of the
  existing Mistral diarization output; adjustable inside the pure module with tests.
- Resampler: linear interpolation, stateful fractional position. The executor first greps the desktop repo for
  an existing PCM resampler and reuses it if one exists.
- New desktop code goes into fork-owned modules (`sttApiStreaming.js`, `sttApiStreamPolicy.js`,
  `scribeSegments.js`); upstream-owned files get thin call sites only, per the fork note in
  `.claude/CLAUDE.md`.
</decisions>

<blockers>
## Blocker Candidates (flagged per the brief)

| ID | Blocker | Kind | Blocks | Owner-only? |
|----|---------|------|--------|-------------|
| B1 | Prod offline engine respawn loop (`respawn_failures_total` 23400). Ticket `c0533c8f-5330-4199-b39b-9e8f0b420bd9`. | Defect | 05-01 Task 5 and 05-02 Task 6 (upload and dictation proofs) | No. 05-01 Task 4 root-causes it from Coolify logs. |
| B2 | Streaming not configured on prod; needs `STT_STREAM_MODEL`, weights, and RAM/CPU headroom on the Coolify host. Online pool cap is 2 streams, so at most one meeting (mic + system) or two previews at a time. | Infra capacity | 05-01 Tasks 4-5, 05-02 Task 6 (meeting and preview proofs) | No for checking (Coolify MCP). Yes if the host lacks capacity and a bigger server or GPU must be bought. |
| B3 | `TITANIUM.keygenProductId` is empty in `fork.config.json`; no real license exists for an end-to-end desktop proof. | Missing provisioning (AUTH-01) | 05-02 Task 6 only | Possibly; first check Titanium Licensing admin and Proton Pass for an existing product/license. |
| B4 | No stable domain (STT-03). | Not blocking | None; the Coolify hostname is used. | No |
| B5 | Cleanup runs on the owner's Claude subscription OAuth for every license holder. Already true for in-band cleanup; `/v1/chat/completions` widens it to client-chosen system prompts. | Business note | None (mitigated by D-03 caps) | Owner awareness only |
</blockers>

<deferred>
## Deferred Ideas (NOT in plans)

- Multilingual streaming model (`nemotron-3.5-asr-streaming-0.6b`) on prod.
- Committing dictation text from the stt-api stream (streaming commit) instead of the batch POST.
- Routing the voice-assistant, note-formatting and chat-intelligence LLM scopes to stt-api.
- Per-license usage quotas and billing metering on `/v1/chat/completions`.
- Showing word-level timestamps in the note editor.
- Stable domain for stt-api (STT-03, separate phase).
</deferred>

<canonical_refs>
## Canonical References

Desktop (`C:\Users\artic\GitHub\openwhispr-tiwh-planning`, branch `docs/tiwh-planning-p5-7`):
- `src/config/fork.config.json`, `src/config/forkDefaults.ts`, `src/stores/settingsStore.ts` (FORK_DEFAULTS use near lines 1548-1566 and 1747; cleanup keys near 1568-1586; `isCloudCleanupMode` near 3320)
- `src/helpers/titanium/titaniumIpc.js` (`titaniumServiceKeyFor`, IPC `titanium-service-key`)
- `src/helpers/audioManager.js` (STT key fallback near 2725; preview worklet gating near 1646-1696)
- `src/helpers/ipcHandlers.js` (`MEETING_STREAM_SAMPLE_RATE` line 216; meeting prepare near 9182-9260; `start-dictation-preview` 9917, `dictation-preview-audio` 9980, `stop-dictation-preview` 10044; `transcribe-audio-file-byok` 10700-10995)
- `src/helpers/meetingStreamingProviders.js`, `src/helpers/meetingTranscriptionRouting.js`, `src/helpers/deepgramStreaming.js`
- `src/helpers/uploadTimestamps.js`, `src/services/fileTranscription.ts`
- `src/services/ReasoningService.ts` (`getApiKey("custom")` near 197; `isAvailable()` near 1372-1400), `src/services/ai/inferenceProviders/openai.ts`
- `src/stores/meetingRecordingStore.ts` (call to `resolveMeetingTranscriptionOptions` near line 166)
- Root `CLAUDE.md` sections `### 18.` and `### Services`

Server (`finedesignz/openwhispr-stt-api`, `origin/main` ecdd53f):
- `api/streamRoute.js`, `api/engine.js`, `api/enginePool.js`, `api/config.js`, `api/app.js`
- `api/scribeRoute.js`, `api/scribeResponse.js`, `api/claudeCli.js`, `api/cleanupPrompt.js`, `api/licenseAuth.js`
- `src/helpers/parakeetWsServer.js` (`createOnlineStream`), `src/helpers/parakeetWsResult.js` (`createOnlineAccumulator`)
- `test/attribution.test.js` (rules for edits under `src/`)
</canonical_refs>

---
*Phase: 05-self-hosted-parity*
*Context gathered: 2026-11-18*
