# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.5] - 2026-07-10

A model-breadth and reliability release on top of 1.7.4: the latest cloud reasoning models (OpenAI GPT-5.6 and Anthropic Claude Fable 5 / Sonnet 5), Corti as a private clinical reasoning provider with in-region routing that keeps transcribed medical text off third-party LLMs, Tinfoil confidential transcription extended to uploaded audio and every batch path, OpenRouter as a first-class LLM provider with a searchable model picker, enterprise Agent Mode chat with region-aware Bedrock and a live model catalog, multiple hotkeys per action, and a broad stack of meeting-notes, notes, transcription, and platform fixes.

### Reasoning & models

- **New cloud reasoning models.** OpenAI's GPT-5.6 family — Sol (flagship, 1M context), Terra (balanced), and Luna (fastest and lowest-cost) — and Anthropic's Claude Fable 5 (Mythos-class flagship, 1M context) and Claude Sonnet 5 are now selectable in their model pickers. Claude Fable 5 is also offered as an AWS Bedrock enterprise inference profile, and the Claude Opus 4.8 description was re-toned now that Fable 5 is the most capable Claude model. (#1130)
- **Corti — clinical-grade AI reasoning (BYOK).** Corti, added for medical transcription in 1.7.3, is now also a bring-your-own-key reasoning provider built on the Corti Models gateway. When a healthcare user accepts Corti during onboarding, dictation cleanup and every LLM scope route to Corti so transcribed clinical text never reaches a general-purpose model, and Corti's availability now counts toward having a reasoning provider (cleanup was previously skipped silently for Corti-only setups). The gateway is EU-only and speaks Chat Completions, noted at the top of the Corti reasoning tab. (#1111, #1127)
- **Clinical reasoning stays in-region.** The Corti Models gateway is EU-only and needs its own key, so a US clinical user used to get Corti transcription while every LLM scope stayed on the default provider (OpenAI) — sending transcribed clinical text to a third party. Onboarding now routes reasoning to Corti only in the EU region with a key, and to the HIPAA-compliant OpenWhispr Cloud everywhere else, never a third-party LLM. The region selector drives which fields appear, and the reasoning model selector flags the EU-only requirement in all ten locales. (#1128)
- **OpenRouter — first-class LLM provider.** OpenRouter is now its own cloud provider tab with its own encrypted API key, instead of requiring the generic Custom OpenAI-compatible field (which leaked the shared custom key on a tab switch). Its 300–400 models render in a new searchable, grouped model picker — filter, grouping by provider with per-vendor icons, virtualized rows, and a pinned "Selected" group — which also kicks in for any OpenAI-compatible provider above 12 models. Outbound partner links (BYOK key pages, HuggingFace model pages) now carry OpenWhispr UTM attribution. (#1002)
- **Enterprise: region-aware Bedrock, a live model catalog, and Agent Mode chat.** AWS Bedrock inference profiles are geo-scoped, but suggested model cards always used `us.`-prefixed IDs, so non-US regions rejected them with "the provided model identifier is invalid"; model IDs are now region-aware and rewritten when you change region. A new "Browse all models" button loads the live Bedrock catalog resolved against your own credentials and region, so a picked model is always invocable. Agent Mode chat — the tool-using agent overlay — now works with AWS Bedrock through an IPC-proxied model, and the stop button and window unmount actually cancel enterprise streams now instead of billing to completion. Suggested Bedrock models were refreshed to Claude Sonnet 5 and Claude Opus 4.8 and gained on-demand GPT-OSS 120B, DeepSeek V3.2, and Qwen3 Next 80B; enterprise inference now uses the calling scope's provider instead of always reading the cleanup provider. (#1118)

### Transcription

- **Tinfoil — confidential transcription for uploaded audio and retries.** Tinfoil was wired only into the realtime dictation socket, so audio upload, retries, and the streaming fallback all fell through to `api.openai.com` — sending the Tinfoil key, or a user's audio under a valid OpenAI key. Every batch path now runs through the attested Tinfoil client (Voxtral), and the streaming fallback routes to the user's configured provider instead of always calling OpenWhispr Cloud. One Voxtral model now covers both realtime and batch, error codes survive the proxy boundary (so `INVALID_KEY` drives the Settings CTA and 429/5xx map to localized messages), and the custom dictionary is forwarded as a prompt. (#1120)
- **Tinfoil model list is now dynamic.** The Tinfoil catalog is fetched from `/v1/models` (verified against enclave attestation) and refreshed in the background, with three bundled models as an offline fallback. A refresh that retires a model you're using switches you off it with a toast rather than silently 404-ing, the fetched list is cached across launches, and new users start on a named default instead of whatever the list happens to return first. (#1115)
- **Cloud recordings retry transient chunk failures.** Long cloud recordings are split into ~4-minute chunks, and a single transient failure (Vercel timeout, 5xx) used to permanently drop a chunk — a silent hole in the transcript, or a failed job. Failed chunks now retry up to twice with backoff (skipping permanent errors: auth, word limit, no speech, other 4xx), non-JSON platform error bodies are classified as coded server errors instead of throwing "Invalid JSON response", and a partial-transcription warning surfaces as a dictation toast and an upload completion notice. (#1094)
- **Local transcription no longer breaks from binaries stranded inside the app archive.** `fs.existsSync` returns true for paths inside an asar, so a missing unpacked `ffmpeg-static` binary was reported as spawnable and every local transcription failed with a cryptic spawn `ENOENT`; resolution now falls through to the system/PATH scan with an actionable error. On Windows the `ps-list` vendor executable was likewise left inside the asar, breaking meeting-app process detection on every poll. Both binaries are now unpacked, and packaging fails loudly if either is missing rather than shipping broken transcription. (#1124)

### Meeting notes

- **Diarization no longer collapses every remote speaker into one.** A meeting with no stored speaker count and no participants fell back to a default of two, capping "other" speakers at one — so every remote voice merged into a single speaker, and naming it locked that whole side of the call to one person. The live speaker cap is now seeded at meeting start from the note and its calendar participants (held in memory for the session so a later edit or sync can't clobber it mid-call), offline diarization can refine a user-locked cluster that it splits into multiple speakers, and a rolled-back start no longer leaks a stale cap. Local meeting edits (participants, calendar event, transcript) are also re-flagged as sync-pending and preserved on cloud pulls, so a later last-writer-wins pull can't wipe them. (#1126)
- **Meeting streams survive the 60-minute session limit.** OpenAI Realtime sessions expire after 60 minutes; meeting streams now auto-reconnect across the expiry with a pre-connect buffer so no audio is lost, and a failed reconnect tears down the half-open streams and restores the working ones instead of leaking sockets or stopping transcription. Dictation keeps its existing auto-stop-with-accumulated-transcript behavior at the limit. The ONNX worker is now also verified into production builds (packaging fails if it's missing), fixing a utility-process crash-loop. (#830)
- **Local speech is no longer silently dropped from meeting transcripts.** Held-back meeting mic segments were discarded on audio-only echo evidence even when no system transcript matched them — field logs showed genuine local speech during double-talk being deleted. A transcript text match is now the only condition that drops a held-back segment; audio evidence can delay a segment but never discard it, and late-arriving system transcripts can still retract released echo within the full duplicate window. (#1093)

### Notes & history

- **Note enhancement stops borrowing another note's transcript and renaming titled notes.** The meeting-recording transcript is global and persists after a recording stops, and the enhance action used it unguarded — enhancing any note after a meeting fed it the last recording's transcript, producing identical enhanced content across notes and leaking one meeting into another. Enhancement is now gated on the transcript belonging to the active note, auto-titling is opt-in per run and only renames empty- or default-titled notes, and the transcript is folded into the staleness hash so edits to it re-trigger enhancement. (#1119)
- **Line breaks show in the history view.** History entries now render with `whitespace-pre-wrap`, matching how transcripts display everywhere else. (#1015)

### Hotkeys

- **Multiple hotkeys per action.** Each hotkey slot — dictation, agent, voice agent, and meeting — can now be bound to several hotkeys, so the same action fires from different keyboards. A new "Add another hotkey" row stacks bindings with per-slot duplicate guarding and atomic updates (a partial registration failure rolls the slot back rather than leaving a dead entry). Full support across `globalShortcut` and the native listeners (macOS Globe/mouse/right-modifier, Windows/Linux low-level hook, push-to-talk); GNOME, KDE, and Hyprland apply the primary hotkey. Comma-key hotkeys (e.g. `Control+,`) are preserved instead of being split on the list separator, and bindings persist as a backward-compatible comma-separated list. (#1017)

### Clipboard & paste

- **Dictating into Claude Desktop and claude.ai no longer breaks after the first paste.** The auto-learn correction monitor used to force the `AXEnhancedUserInterface` accessibility flag onto the app it pasted into. On some Chromium apps (Claude Desktop, claude.ai in any browser) that flag permanently blurs the message composer, so every dictation after the first pasted into a field that no longer had keyboard focus. Monitoring is now strictly read-only: apps that expose their accessibility tree keep auto-learn working as before, and apps that don't simply skip correction learning for that paste. Restart the affected app once after updating to clear the stuck flag. (#1116)

### Audio & media

- **No more false "No audio detected" on Windows.** The speech gate's AudioContext can stay suspended or stall on Windows (Bluetooth headsets, wedged output devices), so its analyser read flat silence and rejected recordings that actually captured speech. A suspended context is now resumed, gate windows are skipped while the context isn't running (the recording proceeds straight to transcription and the gate reports "unavailable"), and cancelling a recording tears the gate down instead of leaking its interval and AudioContext. (#1125)

### Windows

- **No more Windows Firewall prompt for local Parakeet transcription.** The bundled sherpa-onnx server only serves OpenWhispr itself over `127.0.0.1`, but the upstream binary has no loopback-only bind option, so Windows raised an "allow public and private networks" prompt when it started. All-users installs now register a scoped inbound block rule for the server binary: the prompt is gone, the port is closed to the network, and transcription is unaffected because Windows never filters loopback traffic. The rule is removed on uninstall. (#1090)

### Linux

- **Wayland global hotkeys no longer crash on Node 24.** The D-Bus integration for GNOME, KDE, and Hyprland global shortcuts moved off the unmaintained `dbus-next` (last updated in 2021, built on Node APIs removed in Node 24) to `@homebridge/dbus-native`. The switch also fixes the KDE pre-registration conflict check (the invoke callback delivers the unwrapped return value, not a message object, so the check never fired) and attaches an error listener to each session bus, so a stale `DBUS_SESSION_BUS_ADDRESS` can no longer take down the process with an unhandled error. (#1101)

## [1.7.4] - 2026-07-07

A feature-and-hardening release on top of 1.7.3: Tinfoil confidential inference for both transcription and AI reasoning, Azure AI Foundry / Azure OpenAI speech-to-text, native Windows system-audio capture for meeting notes, enterprise SSO in onboarding, cross-device Snippets sync, ambient sync that now runs even in tray-only sessions, and a broad stack of fixes across cleanup routing, clipboard, media playback, hotkeys, local GPU transcription, macOS paste, updates, and Linux packaging — plus SOC 2 dependency remediation.

### Transcription

- **Tinfoil — confidential cloud transcription (BYOK).** New bring-your-own-key provider built on Tinfoil's attested secure enclaves for private cloud speech-to-text in both dictation and uploaded audio. The client verifies enclave attestation before every request and connects over an enclave host assigned dynamically at runtime. (#944)
- **Azure AI Foundry / Azure OpenAI speech-to-text.** The custom transcription provider now recognizes Azure endpoints (`*.cognitiveservices.azure.com`, `*.openai.azure.com`, `*.services.ai.azure.com`) and builds the deployment-style URL Azure requires (`/openai/deployments/{model}/audio/transcriptions?api-version=...`) instead of the plain OpenAI `{base}/audio/transcriptions` shape, which returned `404 DeploymentNotFound`. Auth now uses Azure's `api-key` header on Azure hosts. Enter your resource endpoint as the URL and your exact deployment name in the Model field; `api-version` defaults to a transcribe-capable preview and can be overridden by appending `?api-version=...` to the endpoint. (#997)
- **Configurable self-hosted model.** Self-hosted / local transcription endpoints can now specify which model to request instead of being pinned to a fixed default. (#1043)
- **Hardened realtime dictation streaming.** The realtime streaming connection is more resilient, and 16 kHz capture is now linearly upsampled to the 24 kHz OpenAI's realtime API requires — fixing outright BYOK connection rejections (`invalid_request_error: integer_below_min_value`) and a 1.5× speed mismatch on cloud sessions pinned to 24 kHz. (#1044)
- **Local GPU model reloads after sleep.** Waking the machine no longer leaves the on-device GPU transcription model in a broken state; it's reloaded automatically. (#1032)
- **Multi-GPU device selected by UUID.** The local transcription server now pins its GPU by stable UUID instead of a numeric index, so it keeps using the intended device across reboots and driver reordering on multi-GPU machines. (#1018)
- **Empty recordings no longer crash transcription.** A zero-length recording is handled gracefully instead of taking down the transcription pipeline. (#891)
- **Bundled VAD model in packaged builds.** The `ggml-silero` voice-activity-detection model is now copied into the packaged app, so production builds run local transcription with VAD instead of logging "model not found" and running without it. (#1000)

### Reasoning & models

- **Tinfoil — confidential AI inference (BYOK).** Tinfoil is also available as a private reasoning/agent provider, with six chat models (reasoning-capable ones expose a disable-thinking toggle, matching Groq) verified against enclave attestation before each request. (#875)
- **Hardened dictation cleanup and wake-word routing.** The cleanup prompt was rewritten to reliably transform — not reply to — transcripts: transcripts are framed in `<transcript>` tags with a trailing output anchor, cleanup runs deterministically at temperature 0, and cloud cleanup requests now pin `promptMode: "cleanup"` so the server can't flip them to the action prompt when the dictation agent is off. Agent routing now requires the agent to be genuinely addressed (at the start of a dictation, after a greeting cue, or opening a new sentence) instead of firing on any mention of the agent's name anywhere in the transcript. (#1073)
- **Bundled llama.cpp updated to b9763** for local LLM inference. (#995)

### Meeting notes

- **Native Windows system-audio capture.** Windows previously captured meeting audio only through Chromium's display-media loopback, which hears just the default output device — so a meeting playing to a non-default device produced silent notes with no error. A new native WASAPI process-loopback helper hears every application on every output device while excluding OpenWhispr's own process tree, and transparently falls back to the Chromium loopback path on Windows versions without process-loopback support (< 10 2004). (#960)

### Sync

- **Ambient sync now runs in tray-only sessions.** Auto-sync scheduling (initial pass, window focus/visibility, network reconnect, and a 5-minute interval) moved out of the Control Panel and into `SyncService`, so a start-minimized session that never opens the panel still pushes dictations up and pulls changes from other devices down. Passes are serialized across windows with a Web Lock and share a single throttle window; manual syncs wait for the lock instead of being dropped. (#1070, #1072)
- **Snippets sync across devices.** Your spoken-trigger Snippets now sync across signed-in devices, matching the cross-device custom-dictionary sync added in 1.7.3. (#1037)
- **Default folders link to existing cloud folders** instead of registering duplicates, so signing in on a new device no longer creates a second copy of your built-in folders. (#1086)

### Dictation & snippets

- **Snippets match triggers containing Turkish İ and ı.** Trigger matching used `toLowerCase()`, whose lowercase form of İ (U+0130) is "i" plus a combining dot, so a snippet like "İmza" never matched the transcript — and the regex `/i` flag case-folds neither İ nor dotless ı (U+0131). Triggers and matches are now folded to a canonical key, the pattern matches İ/ı explicitly, and the transcript is NFC-normalized, so "imza", "İmza", "İMZA" — and "Işık"/"IŞIK" for an "ışık" trigger — all expand the same snippet. (#1050)

### Onboarding & sign-in

- **Enterprise SSO sign-in.** Onboarding now offers "Sign in with SSO" alongside social and email/password: it reuses your typed work email, opens the external browser to the SSO flow, and returns via the `openwhispr://` callback. (#1034)
- **API-key drafts are saved on click-outside instead of discarded.** Typing a key and clicking the next field used to silently revert it to empty — worst for Corti BYOK users pasting a client ID and then clicking the client-secret field during onboarding. Click-outside now commits the draft; Escape and the ✕ button still cancel. (#1039)

### Clipboard & paste

- **Rich clipboard formats preserved on restore.** After auto-paste restores your previous clipboard, RTF and other rich formats survive instead of being flattened to plain text. (#1020)
- **Faster macOS clipboard restore.** Removed an unnecessary delay when restoring the clipboard after pasting on macOS. (#1038)
- **Reliable target-app focus before pasting on macOS.** The paste keystroke is delivered session-wide, so it only lands in the right field when the captured target app is frontmost. The target is now located by scanning running applications (the previous lookup returned `nil` under JXA, so activation silently no-op'd and #668's fix never ran), an already-frontmost Chromium/Electron app is left alone to avoid dropping its text field's focus, and the voice-agent hotkeys now capture the target PID so their paste can refocus too — all with no added latency. (#1000)

### Audio & media

- **Mic retries on the default device when the pinned one is stale.** If a previously selected `deviceId` no longer resolves, recording falls back to the system default microphone instead of failing. (#978)
- **Media playback resumes when recording stops, not after transcription** — so paused music or video comes back the moment you finish speaking rather than after the transcript is processed. (#1030)
- **No media pause for a recording that already ended.** A quick tap during streaming-recording startup could pause media with nothing left to resume it (and play cues out of order); post-start side effects are now gated on the recording still being active. (#1061)

### Hotkeys

- **Modifier-only hotkeys work simultaneously on Windows/Linux.** The native low-level key listener was a singleton hardwired to the dictation slot, so only one modifier-only hotkey (dictation, voice agent, agent, or meeting) worked per session. It's now a multiplexer that watches one hook process per key and routes key-tagged events to the right slot, mirroring macOS — and it skips the listener entirely on GNOME/KDE/Hyprland, where shortcuts arrive via D-Bus. (#1001)

### Linux

- **Fall back to `--no-sandbox` when user namespaces are restricted**, so the app still launches on hardened kernels that disable unprivileged user namespaces. (#1042)
- **RPM installable on openSUSE.** Fixed packaging so the `.rpm` installs there. (#1014)

### Updates

- **No crash on the first "Install & Restart" click after an update.** The manual `app.emit("before-quit")` passed no event object, so `event.preventDefault()` threw and the first click did nothing (the second only "worked" because the crash had left the app in a shutting-down state). Pre-quit cleanup now hooks the correct `before-quit-for-update` event on Electron's native `autoUpdater` — fixing stalled macOS installs — and shuts sidecars down on the update path. (#1012)

### Security & dependencies

- **Cleared all critical/high dependency alerts** (form-data, tar, undici, ws) as part of SOC 2 Type 2 secure-code remediation — 1 critical + 10 high Dependabot alerts resolved, no source changes. (#1051)
- **Restored lockfile integrity hashes and added a CI guard.** Regenerated `package-lock.json` on Node 24 so all 967 package entries carry `resolved` + `integrity` fields (up from 53), restoring tamper verification for `npm ci`, and added a `lockfile-lint` workflow to keep it that way. (#1069)

## [1.7.3] - 2026-06-23

A big release: two new transcription providers (Corti for clinical-grade medical dictation and xAI), a reworked onboarding flow built around what you'll use OpenWhispr for, spoken Snippets, a dedicated Voice Agent hotkey, a redesigned dictionary with cross-device sync, dedicated Audio Upload transcription settings, discarded-dictation history, OS-level notification controls, Linux PipeWire system-audio capture, new AI models, and a stack of fixes across paste, audio, settings, and Linux window managers.

### Transcription

- **Corti — clinical-grade medical transcription (BYOK).** New bring-your-own-key cloud provider built on Corti (corti.ai) for HIPAA-compliant, clinical-grade speech-to-text in dictation and uploaded-audio notes. The main-process client mints OAuth2 client-credentials tokens and stores credentials in the encrypted keychain like every other key. (#929)
- **xAI speech-to-text.** Added xAI as a cloud transcription provider. (#942)
- **Corti onboarding polish.** Added the Corti provider icon, and the "Get a key" link plus the onboarding Corti links now point to the corti.ai homepage with referral UTM tracking instead of the bare console.
- **Self-hosted servers skip the API-key check** so local / self-hosted transcription endpoints work without a key. (#835)
- **Dedicated Audio Upload transcription settings.** Uploaded audio files now have their own Speech-to-Text context (Settings → Speech-to-Text → Audio Upload) with an independent provider and model, split out from dictation the same way Note Recording was. Existing users' dictation preference is migrated over; new users default to OpenWhispr Cloud.
- **Cancel an in-progress audio-file transcription** from the upload screen — cancelling returns to the upload view and discards the result so nothing is saved.

### Reasoning & models

- **New models:** Claude Opus 4.8 (#884), Gemini 3.5 Flash (#837), and Gemma 4 (#892) are now selectable in their respective model pickers.
- **Correct limit-error handling for BYOK and cloud reasoning.** (#941)

### Dictation & notes

- **Snippets — spoken trigger-word expansion.** Save trigger → replacement pairs (e.g. "cal link" → "cal.com/anna/30min"); when a trigger is spoken during dictation it's replaced before pasting. (#934)
- **Voice Agent hotkey.** A dedicated global hotkey that sends a dictation straight to the dictation agent as a command — no wake word — and always bypasses the cleanup model, separate from the chat-agent overlay hotkey. (#932)
- **Smart spacing around dictated text** so inserted text spaces correctly against surrounding content. (#856, #868)
- **Redesigned dictionary page** — list view with hover-revealed inline edit/remove, an agent header card, and bulk import/export. (#933)
- **Dictionary prompt-echo fix** so dictionary terms no longer leak into transcripts. (#852)
- **Cross-device custom dictionary sync.** Your custom dictionary now syncs across signed-in devices, with last-writer-wins conflict resolution so edits and deletions converge cleanly. (#966)
- **Discarded dictations are preserved in history.** Cancelled, too-short, or failed dictations are now kept and surfaced behind a "Show Discarded" toggle in History instead of vanishing. (#964)

### Onboarding

- **Intent capture up front.** A new "About you" step lets you multi-select what you'll use OpenWhispr for — dictation, meetings, healthcare, translation, AI commands, or uploading audio — and the rest of onboarding adapts to your choices.
- **Inline Corti setup for healthcare.** Picking healthcare surfaces Corti on the finish step — enter Corti credentials right there or open Settings with the Corti provider preselected, with a "Skip for now" escape.
- **Skippable optional steps**, onboarding progress moved into the macOS title bar, the quit button removed from the title bar, a back-to-sign-in escape on email verification, and ghost-variant styling for subtle auth actions.
- **Provider chips styling fix** on the notes onboarding screen. (#916)

### Settings & notifications

- **OS-level notification controls.** New settings to scope which OS-level interruptions OpenWhispr raises. (#781)
- **Remove button for the agent hotkey.** (#824)
- **Simpler meeting detection.** Audio-based meeting detection is now driven by the notification toggle (`notificationsEnabled && notifyMeetingDetection`) instead of a separate Audio Detection setting; the standalone setting, its UI section, and the now-dead detection translations were removed so a detector can't burn CPU while notifications are off.
- **Settings no longer grabs the microphone.** Opening Settings used to call `getUserMedia` to read device labels, which started a mic session and interrupted other audio (e.g. paused music on macOS). It now enumerates devices first and only falls back to `getUserMedia` when labels are missing because permission hasn't been granted.
- **Custom cleanup API key persists across restarts.** (#893)
- **Download progress is preserved across tab switches.** (#735)
- **Select trigger background aligned** with surrounding controls. (#825)

### Linux

- **PipeWire system-audio capture** for transcriptions via a direct PipeWire loopback (replacing the ScreenCast portal path). (#904)
- **Nix flake** for one-command install, plus a GitHub Action. (#886)
- **Paste reliability:** Shift+Insert paste for Electron app windows (#873) and when the window context is unknown (#827); the ydotool socket is now propagated to spawned clients (#962).
- **Dictation hotkey no longer dies in Hyprland** on config reload. (#919)
- **Fall back to the system journal** when the user journal has no KWin entries. (#776)

### Fixes

- **Auto-paste in Chromium-based apps on macOS.** (#668, #823)
- **Mic re-acquired when it goes silent after idle.** (#922)
- **Serialize `.env` writes** to prevent an ENOENT rename race. (#940)
- **Fall back to JS extraction** when system unzip is unavailable. (#775)
- **Localized Language Models settings** across all locales (#887); fixed zh-CN note-files description mojibake (#848).
- **Local semantic search restored in packaged builds.** A regression that broke on-device semantic note search in packaged (production) builds is fixed. (#981)
- **Faster local transcription:** the bundled Whisper server now auto-tunes its thread count to the machine. (#994)
- **Accurate live speaker counts in note recordings** — per-segment "Speaker N" labels no longer climb past the expected speaker count, and the recorder panel now follows the cursor to the active monitor. (#967)
- **Cloud users no longer need to manually pick a model** for the Voice Agent hotkey or note formatting — both now reach the OpenWhispr cloud agent without an explicitly selected model.
- **No stale clipboard restores during paste**, and cloud requests that hit a stale auth token now recover via the session cookie (fixes onboarding intent silently failing to save after email/password sign-in).

## [1.7.2] - 2026-05-20

A small patch on top of 1.7.1: zero unnecessary macOS Keychain prompts on first launch, working cloud transcription on Electron's `net.fetch`, the Note Formatting selector now actually controls model routing, Wave Terminal pastes via the terminal path, and a notes view stability fix.

### Desktop & permissions

- **No more spurious macOS Keychain prompts on first launch.** Two changes drop first-launch prompts from ~3 to 0: the environment manager no longer eagerly probes the secret-crypto backend before any window appears (it now defers Keychain access until the user actually saves their first secret), and the `safeStorage` key-loss backup is written only when a new master key is generated, not on every launch.

### Transcription

- **Cloud transcription works again on Electron's `net.fetch`.** The 1.7.0 migration from `https.request` to `net.fetch` carried over a manual `Content-Length` header, which Electron rejects as a forbidden Fetch header — `net::ERR_INVALID_ARGUMENT` before any bytes hit the wire. All five upload callers (cloud-transcribe, chunked cloud transcribe, retry, file upload, BYOK whisper-compatible) now let `net.fetch` set Content-Length itself.

### Notes

- **Note Formatting selector now actually controls model routing.** The Note Formatting tab exposed model / mode / provider keys that no runtime path read — `actionProcessingStore` was overriding any caller-supplied model with `getEffectiveCleanupModel()`, so switching the selector was a no-op end-to-end. Generate Notes now resolves through the same per-scope plumbing as Cleanup, with a `dictationCleanup` fallback so users who never touched Note Formatting keep their existing behavior. Closes #784.
- **Notes view state management.** Fixed a stale-ref issue where switching between notes could lose unsaved enhanced-content edits.

### Linux

- **Wave Terminal paste.** Added Wave Terminal to the terminal allowlist so auto-paste uses `Ctrl+Shift+V` instead of the default `Ctrl+V`. Closes #814.

## [1.7.1] - 2026-05-20

A follow-up to 1.7.0 with a stronger encryption key for stored secrets, end-to-end voice activity detection on local Whisper, macOS mouse-button hotkeys, the full OpenAI Realtime GA migration, proxy-aware network paths, and a stack of platform fixes across Linux WMs, Intel Macs, and Windows.

### Security

- **Stronger encryption for stored secrets.** Secrets are now encrypted with AES-256-GCM using a 32-byte master key stored in the OS keychain via `@napi-rs/keyring` (Keychain on macOS, Credential Manager on Windows, libsecret on Linux). This replaces Chromium's `safeStorage` saltysalt/peanuts fallback as the trust anchor. Existing `safeStorage`-encrypted blobs are migrated transparently on first read — no prompts, no re-entry.
- **Linux without a keyring daemon** continues to fall back to `safeStorage`, matching today's behavior.
- **Key-loss protection.** When the keyring backend loads successfully, the master key is now backed up via `safeStorage` so a future native-module break can still decrypt existing blobs instead of losing them silently.

### Local Whisper: voice activity detection

- **Silero VAD is now wired end-to-end.** The 1.7.0 release exposed VAD tuning UI, but `whisper-server` was never actually started with `--vad` and the Silero model wasn't bundled. This release ships `ggml-silero-v5.1.2.bin` (~864 KB) via a new `download-whisper-vad-model.js` build step, resolves it through `WhisperManager.getVadModelPath()`, and emits the VAD flags only when both `vadEnabled` and the model path are present. Server restart now keys on the VAD model path so toggling the UI takes effect immediately.

### Hotkeys

- **macOS mouse-button hotkeys.** Bind dictation to mouse buttons 4, 5, etc. directly. Capture, validate, and re-bind are wired through the existing globe-listener with a hardened race fix so re-binding doesn't stomp the newly-spawned child process. Compound mouse hotkeys (e.g. `Cmd+MouseButton4`) are explicitly rejected — the native tap only handles bare buttons.

### Notes & dictation

- **Automatic note renaming is now configurable.** A new `autoGenerateNoteTitle` setting in Cleanup turns the auto-title behavior off; the setting is properly registered as a boolean so cross-window storage events don't leave it as the string `"false"` (which silently defeats the toggle). Action processing is now async so the UI doesn't block while a long action runs.
- **Voice Agent rename.** The Dictation Agent tab and toggle are now labeled "Voice Agent" in all 10 locales; the internal `dictationAgent` identifiers are unchanged. The agent system prompt was compressed ~2700 → ~1200 chars now that name detection (`detectAgentName`) handles routing.
- **Custom prompts sync across windows without restart.** Storage events for `customPrompt.*` keys now propagate Control Panel edits to the Main Window immediately.
- **Side-panel layout flip is scoped to the notes view with an active note.** It no longer leaks onto Home, Chat, or Upload when the window is narrow; the layout now also flips correctly when you drag the window narrow on an open note and reverts on widen.
- **Dictation overlay can't steal focus on Linux WMs.** The floating icon is now `focusable: false`, the cross-platform equivalent of the `no_focus [instance="open-whispr"]` workaround Sway/i3/wlroots users were applying by hand. Mouse clicks on mic and cancel still work; auto-paste no longer breaks because the original text field stays focused.
- **Meeting-detected "Start Recording" no longer races on a fresh control panel.** The main process used to fire the `navigate-to-meeting-note` IPC after `did-finish-load` but before React mounted its listener, so the click was silently lost on a newly-created window. Now uses the same store-and-drain handshake the notification window already follows.

### Reasoning & local LLMs

- **Voice Agent only triggers when explicitly addressed.** With `useDictationAgent` on and `useCleanupModel` off, every utterance was previously routed to the agent. Now `detectAgentName` must match; otherwise the request falls back to cleanup if reachable, or skips reasoning. Closes #768.
- **Self-hosted dictation agent uses its own credentials** instead of silently falling back to the cleanup model's URL and API key.
- **Qwen thinking is suppressed on local llama.cpp.** Both the note-formatting and streaming chat-agent paths now send `chat_template_kwargs.enable_thinking: false` (the llama.cpp-compatible flag) so Qwen3.x doesn't exhaust its token budget inside `<think>` and return empty content.
- **Stop sending Ollama-only `think` field to Groq.** Groq strictly validates request bodies and rejects unknown fields, so the suppression helper now picks the right dialect per provider instead of attaching both.
- **`disableThinking` actually reaches every reasoning route.** `resolveReasoningRoute` previously returned a bare `{ kind: "cleanup" }` and the agent config omitted the flag, so `cleanupDisableThinking` and `dictationAgentDisableThinking` were silently dropped before reaching `processWithReasoningModel`. Now propagated through cleanup, BYOK cleanup, and streaming BYOK cleanup — Qwen finally respects the toggle on every STT path.
- **Thinking-model responses parse correctly.** When a local llama-server response only includes `reasoning_content` (no `content` field — common for Qwen3 / DeepSeek-R1 in single-shot mode), the result is now read from that field instead of returning an empty string.
- **Idle local LLM unloads from VRAM** after a timeout, freeing the GPU for other workloads.
- **LAN / custom-cloud URL handling.** Accepts OpenAI-compatible URLs with or without a `/v1` suffix, and no longer produces `/v1/v1/chat/completions` when the stored endpoint already includes the suffix. Both LAN and custom-cloud paths now mirror the SDK's existing v1-suffix fallback.

### Transcription

- **Self-hosted STT endpoint resolution fixed.** `getTranscriptionEndpoint` was only reading `cloudTranscriptionBaseUrl`, which defaults to the OpenAI URL. When `transcriptionMode` is `self-hosted`, the resolver now reads `remoteTranscriptionUrl` and stops silently falling back to OpenAI (which produced a 401).
- **Language preference is preserved on retry, in meetings, and in the dictation preview.** `preferredLanguage` is now threaded through every transcription path; non-English users were previously dropped to auto-detect on those branches.
- **Custom dictionary now reaches the meeting note cleanup prompt.** The meeting branch bypassed the dictation cleanup helper and built its own system prompt inline, dropping the user's dictionary. The substitution logic is now in a reusable helper and called from both branches.
- **Groq Whisper prompt cap fixed.** Custom STT routing to `api.groq.com` is now detected by endpoint URL (not provider name) and the prompt budget is capped at 890 chars (down from 900) to leave margin on UTF-16 codepoint drift.
- **No more boot-time BYOK auto-default override.** A one-shot migration was switching `cloudTranscriptionMode` to `byok` on every cold boot whenever any BYOK key existed, overriding subscribed users' UI selection. Both the persistence bug and the "any key" signal are gone.
- **Parakeet health check no longer stalls.** Removed a `transcribing` flag that gated the watchdog interval but had no other reader — if any error path failed to clear it, the watchdog would skip every tick forever and miss a dead sidecar.
- **Transcription sync survives empty-text cloud rows.** The local `transcriptions` table enforces `text NOT NULL`, but the cloud allowed null/empty rows from earlier failed transcriptions. Pulling one of those would abort the entire sync loop with a `SqliteError`. Empty rows are now filtered on push, skipped on pull, and a defensive coalesce in `upsertTranscriptionFromCloud` guards against future bad inputs.

### Streaming & cloud

- **OpenAI Realtime GA migration complete.** OpenAI removed the Realtime Beta API on 2026-05-12. 1.7.0 dropped the `OpenAI-Beta` header but kept the Beta wire format — transcription still broke because the GA server emits `session.created` / `session.updated` (not `transcription_session.*`) and rejects `transcription_session.update` in favor of `session.update` with `session.type=transcription` and a nested `audio.input.*` schema. The two server-event handlers and the session configuration payload are now on the GA shape. Closes #805.
- **Graceful fallback when the OpenWhispr API URL is unconfigured.** `postServerToken` now attaches a `NO_API` code so `startStreamingRecording` can fall back to batch recording instead of surfacing an unhandled error.

### Networking & proxies

- **All GitHub, cloud, and calendar fetches now go through Electron `net.fetch`.** PR #687 swapped 23 fetch sites onto `proxyFetch` but missed pre-existing private helpers using raw `http`/`https`. Behind corporate proxies these failed with `ENOTFOUND` / `ETIMEDOUT` before the proxy-aware downloader was ever reached (e.g. "Enable GPU" hitting `connect ETIMEDOUT <IP>:443`). Covers `downloadUtils` (new shared `fetchJson`), `llamaVulkanManager` / `whisperCudaManager` (GitHub release metadata, preserving `GITHUB_TOKEN`), `ipcHandlers.postMultipart` (chunked cloud transcribe, BYOK whisper uploads, 5 callers total), Google Calendar OAuth (token exchange/refresh/revoke) and `_apiGet` with a 10s `AbortSignal.timeout`, and the legacy signed-token bearer exchange in `main.js`.

### Calendar

- **Primary-only sync toggle.** A new "Sync primary calendar only" switch on the Google Calendar integration card (defaults on for new connections) ignores events from calendars shared with you end-to-end: fetch captures Google's `primary` flag, selection is filtered, stale events from deselected calendars are purged, and the notification cache and next-meeting timer are reset. Existing connected users are fixed-forward on next launch.

### Platform fixes

- **Meeting recording falls back to mic-only on Intel Macs** when the native CoreAudio process tap fails (ScreenCaptureKit / audio HAL quirks on AMD GPU configurations). The error no longer aborts the entire session — closes #744.
- **`macos-media-remote` works on macOS 15.4+.** Three independent regressions (main-thread deadlock, etc.) caused the binary to always return `NOT_PLAYING` on macOS 26.4.x. Music pause/resume during dictation now works again on the latest macOS.
- **Pop!OS COSMIC is forced to XWayland.** COSMIC's `XDG_CURRENT_DESKTOP=COSMIC` fell outside the relaunch allowlist, so the app ran as a native Wayland client — breaking the orb's initial placement and drag. Now handled like GNOME and KDE.
- **Terminal detection on GNOME Wayland** now uses AT-SPI2 instead of the X11 selection heuristic, restoring `Ctrl+Shift+V` auto-paste for native Wayland terminal emulators. Fixes #725.
- **Konsole on X11 auto-paste fixed.** Konsole intermittently reports no `WM_CLASS` via `xdotool`, so terminal detection went blind and fell through to `Ctrl+V` — which AI terminal agents like Codex and Claude Code interpret as image-paste, producing "No image found in clipboard" instead of pasting text. Detection now reads `/proc/<pid>/comm` as a complementary signal, and Konsole + X11 specifically routes through `xdotool windowactivate --sync key shift+Insert` (the XTest `Ctrl+Shift+V` path was being silently dropped by a long-standing focus/grab quirk). Closes #184; original patch and root-cause by @JGKle.
- **Linux launcher symlinks** (e.g. `/usr/bin/open-whispr` → `/opt/OpenWhispr/open-whispr` from deb/rpm packages) no longer fail with "No such file or directory" — the wrapper now resolves the symlink target before sourcing.
- **Windows: llama.cpp pinned to b8857** to keep `whisper-server.exe` (frozen at OpenWhispr/whisper.cpp 0.0.6) loading correctly. A llama.cpp release between b8861 and b9020 bumped ggml's ABI, leaving local Whisper users on 1.7.0 unable to transcribe; the download script now requests b8857 explicitly.
- **Port availability check probes the wildcard address (`0.0.0.0` / `::`)** so sidecars don't false-positive on a free port when something is already bound on all interfaces. Resolved with a consolidated `serverUtils.isPortAvailable` with IPv6 probe. Closes #748.

### Docs & contributor experience

- **`.github/CONTRIBUTING.md`** now points to the canonical docs site so GitHub surfaces the link in the PR-creation UI.
- **Arch Linux `ydotool` install guide** added to the Linux platform docs.

## [1.7.0] - 2026-04-30

A big release: new sign-in options, smoother meeting recording, faster cross-device sync, a more configurable AI setup, and the long-planned move to our new legal entity (Gizmo Labs Inc.) on macOS and Windows.

### Sign in your way

- **Sign in with Microsoft** — new on this release, alongside Google and email/password.
- **Sign in with Apple** on macOS — native Apple ID flow.
- **Self-hosted authentication.** Sign-in now runs entirely on OpenWhispr infrastructure (we replaced Neon Auth with [Better Auth](https://better-auth.com) at `auth.openwhispr.com`). No third-party vendor lock-in. Self-hosters can point at their own server via `VITE_AUTH_URL`.
- **Bearer-token sessions** stored in your OS keychain replace the old browser-style cookie jar, so signed-in state survives renderer crashes and Electron session resets. Existing 1.7.x users transition silently on first launch.
- **Forgot password** opens a browser tab to `openwhispr.com/reset-password` instead of an in-app form, matching how every other reset flow works on the web.
- **Sign-in buttons disable with a tooltip** when the OS hasn't registered the `openwhispr://` callback handler, so OAuth never gets stuck without a return path.

### Security

- **API keys are now encrypted at rest.** All 12 secrets — every BYOK API key (OpenAI, Anthropic, Gemini, Groq, AssemblyAI, Deepgram, Mistral) and every enterprise cloud credential (AWS, Azure, Vertex) — moved from plaintext `.env` and `localStorage` to per-key files encrypted with the OS keychain via Electron `safeStorage` (Keychain on macOS, DPAPI on Windows, libsecret on Linux). A one-time silent migration runs on first launch with round-trip verification before any plaintext is removed; a sentinel makes it idempotent and re-tryable on partial failure. Closes #532.
- **Non-secret preferences** (regions, endpoints, hotkeys, flags) continue to live in `.env` so power users can keep editing them by hand.
- **Linux without a keyring** falls back to plaintext rather than locking you out, matching Electron's default behavior.

### Meeting recording

- **Background recording.** Meeting capture now lives in a global store with a side-effect-only mount, so the audio pipeline survives navigating to other notes, opening Settings, or any view unmount that previously killed it.
- **Floating recording pill.** When you record one note and navigate to another, a pill appears top-center showing live mic-activity bars, the recording note title, click-to-jump-back, and a stop button.
- **Side-panel layout is opt-in.** A new hotkey-only layout setting (full-width or side-panel) controls whether hotkey-triggered recordings snap the window to a 1/3 panel. Manual record-from-note and calendar joins always open full-width and auto-flip to side-panel only when the window narrows below 1024px.
- **Per-note diarization preferences persist.** Mid-session toggles for "label speakers" and the "others in call" stepper are saved against the note, so a stop/resume keeps your choices instead of falling back to the global default.
- **Meeting metadata syncs across devices.** Participants, calendar event ID, diarization toggle, and expected speaker count now travel through cloud sync alongside note content. Older clients that don't send these fields keep working — the columns are nullable and treated as optional server-side.
- **Three interchangeable streaming providers**: OpenAI Realtime, AssemblyAI Universal-3 Pro, and Deepgram. Which providers are available is set on the OpenWhispr server, so there's no desktop-side toggle to keep in sync.
- **Cleaner mic capture.** A new acoustic gate prevents system audio from leaking into your mic during meetings. Speech onsets are protected so your voice isn't clipped at the start of a sentence.
- **Better echo cancellation** with built-in noise suppression in the same pass.
- **Speaker labels capped to attendee count** — no more phantom "Speaker 3+" labels in 1-on-1s and small groups.
- **Live diarization** stays scoped to the current note's attendees instead of pulling in profiles from unrelated meetings.
- **Stable AssemblyAI / Deepgram turns**: fixed a crash on turn-end and a frame-size mismatch with AssemblyAI v3.
- **Fewer dropped turns**: speech-start timestamps now flow through the echo-leak detector for AssemblyAI and Deepgram (was OpenAI-only).
- **Music pause/resume on Windows is reliable again.** Switching to a `windows-media-control` Python sidecar with a hardened WinRT async bridge fixed a class of GSMTC failures that left playback paused after a recording ended; if GSMTC ever fails, the app falls back to a media-key tap.

### AI configuration

- **Per-scope language model setup**: pick different providers and models for dictation cleanup, the agent, note formatting, and chat. An empty agent setting links back to your cleanup model with one click.
- **Self-hosted reasoning got upgraded.** The Self-Hosted card now exposes URL + API key + model picker (was URL-only), bringing it to parity with Cloud → Custom. Distinct help text on each: Cloud → Custom points at OpenRouter / Together; Self-Hosted explains it's for OpenAI-compatible servers on your local network (Ollama, LM Studio, vLLM, llama-server). Closes #661.
- **Per-scope thinking-mode toggle.** Models that support visible reasoning (e.g. GPT-5/o-series, DeepSeek-R1, Qwen-think) now expose a "show thinking" switch per scope. Defaults to suppressed so the dictation pipeline stays snappy; turn it on per scope when you want to see the model reason.
- **NVIDIA Parakeet `parakeet-unified-en-0.6b`** — a new English-only Parakeet model with state-of-the-art offline accuracy (5.91% avg WER on the HF Open ASR Leaderboard, vs 6.34% for v3) at a slightly smaller ~631MB.
- **Switching agent mode** between Cloud and Local no longer leaves stale provider state behind.
- **More reliable ONNX inference** (speaker embeddings, semantic search): long meetings no longer crash the app from a memory allocation failure deep in the speaker model.
- **Local helpers shut down cleanly on Quit.** Local Whisper, Parakeet, llama-server, Qdrant, and the diarization helper now stop properly when you Quit. If a previous session ever leaves one stuck, the app catches and cleans it up on the next launch — so dictation and transcription work right away without manual cleanup.
- **Local LLM startup is more patient.** llama-server with Vulkan acceleration now gets a longer startup window before the app gives up; a stuck server is also fully stopped before any re-download attempt, so partial files don't get clobbered mid-write.
- **Model downloads work behind redirects.** Whisper, Parakeet, Qdrant, MiniLM, and local LLM (GGUF) downloads from Hugging Face and GitHub Releases now follow 3xx redirects correctly — a regression where the manual redirect handler aborted the request before the follow could land has been fixed.
- **Local LLM downloads share the same plumbing** as Whisper and Parakeet (proxy-aware, resume on stall, retry with backoff), removing ~50 lines of duplicated download code.
- **ONNX worker failures are now visible.** When the speaker-embedding / semantic-search worker crashes, stderr and `onnx-worker.log` capture the cause; the parent caps respawn at 5 attempts and degrades to FTS5 keyword search instead of restarting in a tight loop.

### Sync

- **Cross-device delete** propagates to other signed-in devices for all object types.
- **Folder cascade delete** with a confirmation dialog showing how many notes will be removed.
- **Folders sync immediately** on rename and create (was previously only on update).
- **Transcriptions sync on save** instead of waiting for the next app launch.
- **No more duplicate transcriptions in the cloud.** Each transcription is tagged with a client-generated UUID before upload so the cloud row and local row stay in lockstep — sync upserts the existing row instead of creating a second copy.
- **Folder pull** no longer overwrites a freshly-renamed folder with a stale cloud copy.
- **Server stops overwriting `updated_at`** on every note push, eliminating spurious sync loops.

### CLI

- **Local HTTP bridge** for the `openwhispr` CLI: when the desktop is running, CLI commands hit it directly for note/folder/transcription operations and only fall back to the cloud API if the desktop is closed. Bearer-token auth, 127.0.0.1-only.

### Network

- **Proxy-aware fetches**: Node-side requests now honor the system proxy.
- **Trusts your OS CA store**: corporate TLS interception with a trusted root no longer breaks Node-side requests.
- **Helpful error messages**: connectivity failures explain whether it's an auth-host issue, DNS, port 443, or a TLS certificate, instead of a generic "Network error".

### Other notable improvements

- **Auto-learn corrections** now works for Cyrillic, CJK, Arabic, Devanagari, and other non-Latin scripts.
- **Windows text-field detection** falls back to UIA `TextPattern` when `ValuePattern` isn't available — restoring rich-edit support in apps like RichEdit, Monaco, Qt, and Electron-hosted controls.
- **Chat — first message saved** the moment the conversation is created, eliminating a race that could orphan it.
- **Note move** keeps the active note selected and removes the source-folder entry immediately.
- **Local semantic search (Qdrant)** writes to the user data directory, not the read-only app bundle.
- **No more hotkey re-register storm** when dismissing Settings with a hotkey field focused — the IPC handler short-circuits duplicate listening-mode changes (one call per slot, not four).
- **macOS native helpers bundled correctly.** `macos-audio-tap`, `macos-globe-listener`, `macos-fast-paste`, `macos-mic-listener`, `macos-text-monitor`, `macos-media-remote`, and the `linux-*` helpers now land under `Resources/bin/` in the packaged app — matching where the runtime resolvers and CI verify step look for them.

### macOS / Windows: bundle identifier change

The app's bundle ID changed from `com.herotools.openwispr` to `com.gizmolabs.openwhispr` to match our new legal entity (Gizmo Labs Inc.) and fix the long-standing typo. Your notes, settings, API keys, and downloaded models carry over automatically on first launch.

**Auto-update from 1.6.x cannot reach this release.** Please download the new build manually from [openwhispr.com/download](https://openwhispr.com/download).

A one-time onboarding modal walks you through re-granting Microphone, Accessibility, and System Audio permissions on macOS.

### Upgrade notes

- 1.6.x users: download manually from [openwhispr.com/download](https://openwhispr.com/download).
- You'll be signed out and need to sign in again.
- macOS: re-grant Microphone in-app and Accessibility + Screen Recording in System Settings.
- Self-hosters: rename `VITE_NEON_AUTH_URL` → `VITE_AUTH_URL`; rename the legacy reasoning-model env vars (e.g. `REASONING_MODEL` → `CLEANUP_MODEL`); rename `AGENT_KEY` → `CHAT_AGENT_KEY`. Both old and new names work for two releases.

## [1.6.10] - 2026-04-20

### Added

- **Speaker Diarization Controls**: Global on/off toggle in Settings plus a session-scoped pill in the recording view with its own switch and a "1 other in call / 2 others in call" stepper. Unscoped recordings cap at a sensible default to prevent phantom speakers; calendar attendees or the stepper value override. When labeling is off, transcripts fall back to "You"/"Others" labels derived from audio source
- **Auto-Label 1-on-1 Speakers**: Automatically label system audio speakers in 1-on-1 meetings when exactly two participants are detected (user + one other), creating voice fingerprint profiles and triggering retroactive mapping across past notes
- **Integrations View**: New top-level Integrations surface hosting API key management (relocated from Settings) and a new MCP integration card with a copyable server URL chip for paid users
- **Dedicated Meetings Settings**: Separate Speech-to-Text and Language Model selectors for meeting recording, independent from dictation
- **Streaming-Only Engine Filter**: Note Recording picker now filters to streaming-capable engines (OpenAI Cloud, gpt-4o-transcribe, on-device, streaming LAN servers); self-hosted stays available with a caption warning

### Changed

- **Settings Reorganization**: "AI Models" collapsed into Speech-to-Text and Language Models; "Speech & AI" sidebar group renamed to "AI Models"; Meetings section added with its own sub-tabs; multiple redundant headers removed (sidebar "Settings", Agent Mode, enterprise provider-tabs wrapper, system-prompt textarea wrapper)
- **Agent Hotkey Relocated**: Moved into the Hotkeys section where it belongs, no longer orphaned under Agent Mode
- **MCP Pro Gating**: Free users see an upgrade message on the MCP card instead of operational-looking setup steps; paid users get the full flow
- **README Reframed**: Positions OpenWhispr as an open-source alternative to WisprFlow (dictation) and Granola (meetings)
- **Meeting Sub-tabs Simplified**: Engine selectors now shown directly; "follow main settings" toggles dropped. A one-time migration preserves every existing user's behavior with zero breaking changes

### Fixed

- **Stop Binding Random Notes to 1-on-1 Attendees**: Removed over-eager calendar-event adoption that was auto-linking unassigned notes to the first active 1-on-1 calendar event, stamping unrelated recordings with that attendee's speaker profile
- **Echo Leak Detector Pre-AEC**: Detector was receiving the AEC-cleaned mic buffer so correlation against system reference was always ~0; now runs on the raw mic buffer where the leak actually exists
- **Cloud Sync — Transcriptions Reappear on Restart**: Clearing history hard-deleted locally while cloud rows stayed intact; now soft-deletes with tombstones pushed to cloud before hard-delete
- **Cloud Sync — Folders Reappear on Restart**: Same delete-sync bug as transcriptions; mirrored the notes/conversations pattern with `deleted_at`, `pushFolderDeletes`, and a pull-side tombstone guard
- **Folder Name Collision After Delete**: `UNIQUE(name)` blocked recreating a folder with the same name while its tombstone sat unsynced; tombstoned rows now get a mangled internal name that frees the slot without leaking to cloud
- **View Plans Deep-Link**: `SettingsModal` was initializing `activeSection` to "account" regardless of `initialSection` because `prevOpen` equalled `open` on first mount; moved to lazy state initializers so the resolution branch fires correctly
- **MCP i18n**: Setup steps corrected from OAuth to API key auth
- **Missing Integrations i18n Keys**: Added to en, es, fr locales
- **Legacy Prompts Deep-Link**: Now routes to the Dictation Cleanup sub-tab where PromptStudio lives, instead of falling back to the default tab
- **Japanese / Chinese Sidebar Descriptions**: Rewritten to use the same vocabulary as the actual sub-tabs
- **Spanish Enterprise Strings**: Aligned on "en la nube" for consistency
- **Parakeet Model Cache**: "Open cache folder" now opens at the cache root so downloaded models are actually visible

## [1.6.9] - 2026-04-16

### Added

- **Transcript Export**: Export transcripts to disk as TXT, SRT, or JSON files
- **Disable Auto-Paste Toggle**: New setting to disable automatic pasting after dictation
- **Cloud Sync**: Bidirectional cloud sync for notes, folders, conversations, and transcriptions
- **Linux Push-to-Talk**: Native push-to-talk support on Linux via evdev with permission UX and setup guide
- **Agent Folder Tools**: Agent can list, create, and auto-create folders with semantic folder matching
- **API Keys Management UI**: Manage API keys from within Settings
- **Documentation Link**: Added documentation link to the support dropdown menu
- **Notification Dismiss Circle**: Hover-reveal dismiss circle on notification overlays

### Changed

- **Electron 41 & Node 24**: Upgraded from Electron 39 to 41 and Node 22 to 24
- **Dependency Upgrades**: Bumped TipTap packages, Tailwind CSS/Vite, and other major dependencies
- **Provider Tab Redesign**: Redesigned provider tabs as compact pill buttons
- **Local Model Spec Links**: Replaced local model descriptions with clickable spec links
- **llama.cpp Endpoint Detection**: Detect llama.cpp via `/v1/models` and prefer `/chat/completions` over `/v1/responses`
- **README Overhaul**: Simplified README from 907 to ~130 lines with improved keywords, privacy messaging, and feature parity highlights

### Fixed

- **Windows Hotkey After Lock/Unlock**: Prevent false hotkey activation after Win+L lock/unlock on Windows
- **Windows Push-to-Talk Stuck Recording**: Prevent stuck recording when push-to-talk key-up is missed; remove timeout cleanup
- **Speech Gate Thresholds**: Relaxed speech gate thresholds and added no-audio toast for failed transcriptions
- **Transcription Retry Button**: Show retry button on failed transcriptions
- **Note Editor Sync**: Sync editor content when a note is updated externally
- **Speaker Diarization Thresholds**: Tuned thresholds to prevent excessive speaker creation
- **Live Transcription Preview**: Wired up live transcription preview toggle and restored missing IPC handlers
- **Speaker Reclustering**: Added periodic speaker reclustering, unified recording modes, and autosave transcript
- **Floating Icon Position**: Persist floating icon position setting across restarts
- **TLS/Certificate Errors**: Surface TLS/certificate errors in model download UI
- **llama.cpp Probe**: Made llama.cpp probe one-shot and removed fragile hasMeta heuristic
- **Agent Folder Navigation**: Refetch notes when opening a note in a different folder
- **Notification Window Sizing**: Fixed notification window sizing and dismiss circle visibility
- **Japanese Translations**: Added missing Japanese translations and reordered handler for consistency
- **German Locale**: Fixed invalid JSON in German locale file
- **i18n Spec Links**: Fixed i18n spec link text and renamed to "Learn more"

## [1.6.8] - 2026-04-14

### Added

- **Speaker Diarization**: Live speaker identification during meeting recording with post-processing refinement when the call ends (auto-downloaded sherpa-onnx pyannote + voxceleb models)
- **Speaker Reassignment UI**: Click any bubble to assign it to a known speaker, calendar attendee, or contact — with attendee-aware picker and bulk-select reassignment
- **Voice Fingerprint Linking**: Attach voice profiles to contact emails from the speaker picker
- **Meeting AEC Helper**: Native WebRTC AEC3 sidecar for mic echo cancellation when system audio is captured, with graceful fallback to the JS echo leak detector
- **Transcript-Level Dedupe**: Retract events drop mic duplicates once system audio confirms the same speech, cleaning both the live view and the saved transcript
- **Live Accuracy Hint**: Subtle in-view hint during recording indicating that speaker labels will sharpen once the call ends

### Changed

- **Meeting AEC Helper is Prebuilt**: Binaries are built on CI and downloaded like whisper-cpp / qdrant — contributors no longer need cmake, Python 3, or a C++ toolchain for a normal build

### Fixed

- **Speaker Reassignment for Own Bubbles**: Reassigning a left-side (mic) bubble now correctly flips side, name, and color instead of staying locked as "You"
- **Live Speaker Lock Persistence**: Live-assigned speaker names survive across the session and through diarization merge
- **Meeting System Audio Handling**: Restore system audio handling after transcription path refactor
- **Local Whisper Speech Gate**: Stricter silence gate with peak-amplitude fallback to prevent dropped chunks on quiet but non-silent audio
- **Transcript Merge**: Preserve prior transcript when diarization merge arrives

### Security

- **CMake Quoter Escape**: Single-pass backslash + quote escape in `quoteCmake` resolves a CodeQL incomplete-escape warning

## [1.6.7] - 2026-04-02

### Added

- **Calendar Participants on Meeting Notes**: Automatically link Google Calendar attendees to meeting notes when recording starts from a calendar event, with domain-grouped display and Gravatar avatars
- **Save Notes as Files**: Export notes to the local filesystem as Markdown files, mirroring folder hierarchy
- **Responsive Settings Dialog**: Settings dialog adapts to narrow windows — sidebar collapses to icon rail, rows stack vertically, plan grid reflows
- **Chat Sidebar**: Full sidebar chat tab with conversation history, cloud sync, and semantic search
- **Chat UX Polish**: Empty state with illustration, shimmer thinking/streaming indicator, stop button, action buttons and search dialog
- **Local Semantic Search**: Always-on Qdrant vector DB sidecar for offline semantic search across notes — hybrid FTS5 + vector with Reciprocal Rank Fusion
- **Agent Tool Calling**: Agentic tool-calling system with note management tools (get, create, update, search), cloud agent support with NDJSON streaming, and local model tool calling with RAG context injection
- **Embedded Chat in Notes**: Embedded chat panel in the note editor with floating and sidebar modes
- **Per-GPU Device Selector**: Choose a specific GPU for transcription and intelligence processing (#539)
- **Settings Keyboard Shortcut**: Cmd+, / Ctrl+, keyboard shortcut to open Settings
- **Notes Actions Button**: Actions sidebar button with redesigned action editor dialog
- **Notes Folder Picker**: Folder picker in the note metadata row with cleaned-up input styles
- **Notes Sidebar Buttons**: New note and search notes buttons in the sidebar
- **Meeting Echo Cancellation**: Echo cancellation on mic input and note metadata chips in meeting view
- **Linux Wrapper Script**: Wrapper script to force XWayland and support user flags (#507)

### Changed

- **Vercel AI SDK Migration**: Agent mode migrated from raw API calls to Vercel AI SDK
- **Notes Bottom Bar Redesign**: Redesigned bottom bar with compact action picker
- **Dialog Design System Alignment**: All dialogs aligned with design system guidelines
- **Removed Note Word Count**: Removed word count from note editor
- **Cloud Agent Streaming**: Stream cloud agent responses directly from the renderer via IPC

### Fixed

- **Meeting Auto-Detection**: Fix auto-detection not firing for browser meetings
- **Meeting Transcription Provider**: Use local transcription provider for notes/meeting recording (#530)
- **Meeting Partial Transcript Spam**: Prevent partial transcript spam and duplicate final segments
- **Meeting Notification Timing**: Resolve notification popup timing and detection lifecycle bugs
- **Folder/Note Race Conditions**: Resolve race conditions when switching folders quickly, prevent meeting view from exiting when changing folder, fix rapid delete/switch state management
- **Clipboard Preservation**: Preserve images and HTML in clipboard during paste-and-restore (#381)
- **Transcription Retry Provider**: Retry transcription uses configured provider instead of forcing Parakeet
- **JSON Parse Validation**: Validate JSON.parse result type before calling .replace() in prompts (#541)
- **GPU Selector Polish**: Address code review feedback, rename Intelligence GPU label, fix dropdown chevron padding (#539)
- **Meeting Participant Saves**: Fix calendar attendees not syncing to store and manual participant adds overwriting calendar data
- **Chat Duplicate Conversations**: Fix duplicate conversations — includeArchived filter returned all instead of only archived
- **Linux Wayland Fixes**: Force XWayland on KDE/GNOME Wayland, fix hotkey startup race; use uinput before portal on GNOME Wayland (#468, #494)
- **Mic Permission Gate**: Remove mic permission gate, fix system audio detection
- **Windows Build Signing**: Fix Windows build signing on PRs, add missing mic-listener download, add missing publisherName to Azure signing config
- **Dead optimizeAudio Crash**: Remove dead optimizeAudio call that crashes on recordings over 90 seconds (#524)
- **Download URL Logging**: Remove URL truncation from download log and add failure logging (#540)

### Security

- **Google Calendar Scopes**: Narrow OAuth scope from `calendar.readonly` to `calendar.events.readonly` + `calendar.calendarlist.readonly` for minimal privilege
- **picomatch**: Bump to 4.0.4
- **brace-expansion**: Bump to 1.1.13 (security backport)
- **yaml**: Bump to 2.8.3
- **tar**: Bump to 7.5.13

## [1.6.6] - 2026-03-19

### Added

- **Native macOS System Audio Tap**: CoreAudio Tap API for direct system audio capture — eliminates the need for screen recording permission on macOS 14.2+
- **TipTap Rich Text Editor**: Migrated notes editor from plain Markdown to TipTap with Obsidian-style live preview — hides Markdown syntax except on the cursor line, with rich text rendering for enhanced and transcript views
- **Dual-Channel Meeting Transcription**: Separate mic and system audio channels with chat bubble UI for speaker-differentiated meeting transcripts
- **Meeting Segment Timestamps**: Persist segment timestamps in saved meeting transcripts with chronological ordering
- **Meeting-Specific AI Prompts**: Meeting notes generation now uses speaker-aware prompts for better context in generated summaries
- **KDE Wayland Native Shortcuts**: Native global shortcut support for KDE Plasma on Wayland using D-Bus, matching the existing GNOME and Hyprland approach (#486)
- **Mistral Nemo 12B and Gemma 3 12B**: Added to local model registry for on-device inference (#483)
- **Post-Login Permissions Gate**: Returning users now see a permissions check after login to ensure mic and system audio access

### Changed

- **Unified Notes Recording**: All notes now use dual-stream transcription with simplified recording UX — always saves to transcript
- **Notes Tab Rename**: Renamed "Raw" tab to "Notes" and default to it during meetings
- **Shared Note Title Generation**: Extracted `generateNoteTitle` utility for consistent auto-titling across meeting and regular notes
- **Simplified Permission Buttons**: Consolidated permission prompts to a single "Grant Access" action (#490)
- **screenRecording → systemAudio Rename**: Renamed `screenRecording` references to `systemAudio` across the codebase for clarity
- **macOS 15+ System Audio Consent**: Trigger the native system audio consent dialog on macOS 15+ instead of the legacy screen recording prompt
- **Improved Notes Output**: Better generate notes output format and auto-title generation
- **Update Notification Polish**: Improved update notification transparency, icon, and copy
- **Permission Re-validation**: Re-validate mic and system audio permissions against the OS on component mount

### Fixed

- **Gemini Agent Streaming**: Route Gemini agent streaming to the correct API endpoint
- **Windows Mic Volume Mutation**: Disable browser AGC to prevent Windows mic volume being permanently altered (#476)
- **Linux Mono Transcription**: Request stereo recording to prevent mono transcription failure on Linux
- **Meeting Bluetooth Audio**: Detach meeting AudioContexts from output device for Bluetooth compatibility; fix system audio loopback silence
- **Meeting Detection Suppression**: Suppress meeting detection notifications when meeting mode is already active
- **Windows Paste Modifier Keys**: Release held modifier keys before `SendInput` paste on Windows
- **Meeting Session Reset**: Reset meeting audio send counts between sessions
- **Meeting Hotkey Behavior**: Meeting hotkey always opens a new meeting regardless of current view
- **STT Config Auth Timing**: Retry STT config fetch before recording when auth isn't ready on mount
- **Hotkey Restore on Failure**: Restore previous hotkey on registration failure
- **KDE Wayland Hotkeys**: Force XWayland on KDE Wayland to fix hotkey registration
- **Streaming Dictation Commands**: Use TipTap editor commands for streaming dictation input
- **Google OAuth Onboarding**: Fix Google OAuth users skipping onboarding flow
- **Realtime Dictation Default**: Default streaming provider to openai-realtime for dictation; respect sttConfig dictation mode for realtime models
- **KDE Plasma Overlay**: Fix KDE Plasma hotkey and overlay window behavior — scoped window type changes to KDE only, preserving GNOME behavior (#491)
- **Cleanup Prompt Refusal**: Fix cleanup prompt refusing to output command-like transcriptions (#478)
- **KDE Wayland Clipboard Paste**: Replaced busy-wait with sleep and clean up temp file for KDE Wayland paste (#455)
- **GNOME Agent Hotkey**: Register agent hotkey as independent GNOME Wayland keybinding slot (#436)
- **Agent Hotkey Conflict Warning**: Show conflict warning when agent hotkey duplicates another mode
- **Meeting Hotkey Registration**: Await async `registerSlot` for meeting hotkey registration
- **Media Pause During Dictation**: Prevent paused media from being unpaused during dictation (#419)
- **Meeting Chat Scroll Overlap**: Fix meeting system audio transcription and chat scroll overlap
- **macOS Media Remote Bundle**: Include macos-media-remote in extraResources (#487)
- **NSAudioCaptureUsageDescription**: Restore plist entry and increase audio probe timeout

### Security

- **undici CVE-2026-1526**: Bump undici to 6.24.1 to fix request smuggling vulnerability

## [1.6.5] - 2026-03-17

### Added

- **Data Retention Toggle**: New privacy setting to control whether transcription text is retained in history (Privacy & Data settings)

### Fixed

- **Meeting Detection Reset**: Fix meeting detection not properly resetting after a meeting ends

## [1.6.4] - 2026-03-15

### Added

- **Meeting Mode Hotkey**: Dedicated hotkey to start/stop meeting transcription directly from the keyboard, independent of the dictation hotkey
- **Account Deletion**: Users can now delete their account from within the app
- **Qwen3.5 Local Models**: Added Qwen3.5 local models to the model registry; removed sub-1B models that were too small for practical use
- **Model Descriptions in Picker**: Local model picker now shows model descriptions to help users choose the right model
- **Meeting Detection Toggle**: New setting to enable/disable automatic meeting detection
- **Dependabot**: Automated weekly npm dependency updates via Dependabot
- **CodeQL Static Analysis**: GitHub Actions workflow for automated security scanning
- **Zod Dependency**: Added Zod for input validation and sanitization

### Changed

- **Multi-Monitor Floating Icon**: The dictation floating icon now appears on the monitor where the cursor is, instead of always on the primary display
- **Persistent Panel Position**: Panel start position now persists across app restarts
- **Compact Hotkey Tooltip**: Overlay tooltip uses compact modifier symbols (e.g., ⌘⇧K instead of Cmd+Shift+K), wraps for long combos, and aligns to window edge based on panel position
- **Cross-Window Settings Sync**: Settings changes now sync across all open windows in real time
- **Agent Chat Title**: Renamed agent mode window title from "Agent Mode" to "Agent Chat"
- **Windows Model Preservation**: Local LLM models are now preserved during Windows app updates instead of being deleted

### Fixed

- **Meeting Hotkey Overwrite**: Fixed meeting hotkey accidentally overwriting the dictation hotkey on save
- **Meeting Snap Timing (macOS)**: Fixed meeting mode snap timing on macOS causing incorrect window positioning
- **Meeting Detection False Positives**: Reduced false-positive meeting detection notifications
- **Hotkey Tooltip Display**: Fixed hotkey tooltip not updating after changing the hotkey in settings
- **Silence Detection Threshold**: Lowered silence detection threshold to avoid rejecting valid speech that was previously considered too quiet (#411)

## [1.6.3] - 2026-03-12

### Changed

- **System Audio Permission Clarity**: Renamed "Screen Recording" to "System Audio" across all permission prompts, onboarding, and settings — makes it clear that OpenWhispr captures other participants' audio, not your screen
- **Improved Permission Copy**: Microphone permission now reads "Captures your voice for transcription"; System Audio reads "Captures other participants' audio from calls and meetings. We never record your screen."
- **Electron 39**: Upgraded from Electron 36 to 39, which uses the CoreAudio Tap API by default on macOS 14.2+ — eliminates the purple "screen recording" indicator, the "Your screen is being observed" lock screen message, and the misleading "Screen & System Audio Recording" permission prompt. Users now see "System Audio Recording Only" instead
- **NSAudioCaptureUsageDescription**: Added the new macOS 14.2+ audio capture usage description to Info.plist, enabling the separate system audio permission dialog
- **better-sqlite3 12**: Upgraded from v11 to v12 for Electron 39 V8 compatibility
- **Localized in all 10 languages**: All permission copy changes translated across en, pt, de, es, fr, it, ru, ja, zh-CN, zh-TW

### Added

- **Hyprland Wayland Support**: Native global shortcut support for Hyprland using `hyprctl` keybindings + D-Bus, matching the existing GNOME Wayland approach (#416)

### Fixed

- **Soft Voice Recognition**: Enabled Auto Gain Control (AGC) for dictation microphone input to automatically boost quiet speech — previously disabled, now matches meeting mode behavior
- **OpenAI Realtime VAD Sensitivity**: Lowered voice activity detection threshold from 0.5 to 0.3 (both client and API) so soft-spoken audio is no longer missed
- **Speech Onset Clipping**: Increased VAD prefix padding from 300ms to 500ms to capture the quiet beginning of soft speech that was previously cut off
- **Wayland Clipboard Paste**: Fixed `wl-copy` failing silently due to 1ms `spawnSync` timeout killing the fork before it completed — increased to 50ms (#416)
- **Streaming Media Resume**: Fixed media staying paused after recording silence with "Pause media on dictation" enabled — streaming path now fires the completion callback even when no speech is detected (#429)

## [1.6.2] - 2026-03-11

### Added

- **System Audio for Notes**: Mix system audio (via getDisplayMedia loopback) with microphone input for note recordings, enabling capture of meeting audio, YouTube lectures, and other system sounds
- **Event-Driven Meeting Detection**: Replaced polling-based meeting detection with native OS event APIs (CoreAudio on macOS, WASAPI on Windows, pactl on Linux) — reduces background CPU from 5–9% to near-zero (#404)
- **Notes Onboarding**: Added screen recording permission step to the notes onboarding wizard (macOS) so users can grant permission before their first recording

### Changed

- **Auto-Enable System Audio**: System audio is now automatically enabled when screen recording permission is granted — removed the separate toggle button for a simpler recording experience
- **Deferred Transcript Display**: Recording transcript is no longer shown live during notes dictation; it appears after recording stops, matching the meeting notes flow for a cleaner experience

### Fixed

- **Windows Hotkey Stability**: Track modifier state in native keyboard hook so modifier-only shortcuts (e.g. Control+Super) are detected reliably on Windows 11; keep floating recorder interactive; prefer compiling current key-listener source over downloaded binaries
- **macOS Accessibility Permission Prompt**: Detect missing accessibility trust after startup and notify users with auto-opened Privacy settings and toast guidance — fixes silent Globe key failures on fresh installs
- **Realtime Streaming Warmup**: Fix warmup gating so initial audio is no longer silently dropped; skip redundant session config in cloud mode; handle empty-buffer commit on disconnect gracefully
- **Custom Dictionary Prompt Truncation**: Truncate custom dictionary to respect Groq's 896-char limit, preventing 400 errors on large dictionaries (#405)
- **Parakeet bzip2 on Windows 10**: Add JS fallback for bzip2 extraction when native tar fails (#406)
- **Business Plan Past-Due Check**: Include business plan in past-due subscription check

### Removed

- Removed the Monitor toggle button from the dictation widget (system audio mode is now automatic)

## [1.6.1] - 2026-03-08

### Added

- **WebSocket Streaming for BYOK Dictation**: OpenAI Realtime API streaming now works for standard dictation mode (not just meetings), enabling real-time transcription for Bring Your Own Key users
- **Unified Streaming Path**: Extended OpenAI Realtime WebSocket streaming to normal dictation, sharing the same streaming infrastructure as meeting transcription

### Fixed

- **Transcript Loss on Disconnect**: Commit audio buffer before closing WebSocket and wait for final transcript before closing, preventing lost transcriptions during disconnects
- **Dictation IPC Callbacks**: Send plain strings from streaming IPC callbacks instead of objects, fixing downstream consumers
- **Accessibility Permission Detection (macOS)**: Fix onboarding flow not detecting macOS accessibility permission correctly (#394)
- **Custom Cloud Provider Classification**: Treat Custom Cloud endpoints as self-hosted rather than third-party (#384)
- **Blocking `execSync` in Meeting Detection**: Replaced synchronous process detection with async alternative to prevent UI freezes on Windows
- **BYOK Onboarding Override**: Guard BYOK override for signed-in users and fix missing deps during onboarding (#397)
- **Windows Media Pause Toggle**: Check audio state before sending media key on Windows (#402)
- **Linux Wayland Portal Permissions**: Set desktop name on Linux for Wayland portal permissions (#389)
- **Chrome Sandbox Permissions (Linux)**: Set SUID bit on chrome-sandbox during deb/rpm install

### Changed

- Eliminated duplication and fixed style inconsistencies in dictation streaming helpers
- Cleaned up meeting detection code after the Windows input fix

## [1.6.0] - 2026-03-06

### Added

- **Agent Mode**: Glassmorphism chat overlay with real-time AI streaming — resizable window (8 edge/corner handles), dedicated hotkey, conversation history stored in SQLite, customizable system prompt, and support for all cloud/local AI providers
- **Google Calendar Integration**: Connect multiple Google accounts via OAuth 2.0 (PKCE), view upcoming meetings in the sidebar, and receive notifications when meetings are detected
- **Meeting Recording & Live Transcription**: Automatic meeting detection via process monitoring (Zoom, Teams, FaceTime) and sustained audio activity, with live transcription powered by OpenAI Realtime API over WebSocket
- **Cloud Notes with Sync**: Local-first note storage with FTS5 full-text search, folder organization, cloud sync, and semantic search — all notes are instantly searchable across title, content, and enhanced content
- **Audio Retention & Retry**: Transcription audio is now saved locally with configurable retention (default 30 days), enabling playback from history and one-click retry of failed transcriptions through the full pipeline
- **Cmd+K Command Search**: Global command palette to search across notes, transcripts, and folders with real-time results, keyboard navigation, and type-grouped display
- **Auto-Pause Media Playback**: Automatically pauses media (Spotify, Apple Music, etc.) during dictation and resumes afterward — uses MediaRemote framework on macOS, GSMTC on Windows, and MPRIS2 on Linux
- **Screen Recording Permission Flow (macOS)**: Optional onboarding step and in-app prompts for screen recording permission, required for meeting audio capture on macOS
- **Configurable Recorder Position**: Choose where the voice recorder panel appears on screen (top, bottom, center)
- **Auto-Paste Toggle**: New toggle in clipboard settings to enable/disable automatic pasting after transcription
- **Prompt Architecture Overhaul**: Centralized prompt definitions in `src/config/prompts.ts` with customizable agent system prompts
- **Dynamic Agent Window**: Agent overlay starts at full screen height with drag-to-resize support, persisted window bounds across sessions
- **Save Failed Transcriptions**: Failed transcriptions are now saved with their audio for later retry instead of being lost
- **Cloud Backup Toggle**: Unified cloud backup into a single toggle for simpler settings

### Changed

- **Removed Input Monitoring Requirement (macOS)**: Replaced CGEvent tap with NSEvent monitor for Globe/Fn key detection, eliminating the need for Input Monitoring privacy permission
- **Unified Screen Recording Permission UX**: Consolidated screen recording permission prompts across onboarding, meetings, and integrations into a consistent experience

### Fixed

- **Agent Panel Readability**: Made agent panel fully opaque for better text readability
- **Local Model Streaming**: Fixed local model support in agent streaming and resolved Metal OOM crash on macOS
- **Mic Auto-Gain**: Enabled microphone auto-gain and skip silent system audio chunks during meeting recording
- **Meeting Audio**: Fixed simultaneous system and mic audio capture for meetings
- **KDE Wayland Paste**: Fixed portal exit code 0 with no token being treated as success on KDE Wayland
- **Meeting Detection**: Suppressed false meeting detection when no active calendar meeting exists
- **OpenAI Realtime Session**: Fixed session configuration timing — now sends config after session created event with pcm16 format and VAD
- **Agent Hotkey Persistence**: Agent hotkey now properly persists to `.env` file across restarts
- **Sidebar Height**: Fixed sidebar not extending full window height
- **Empty Transcription Handling**: Silent return on empty transcription instead of pasting fallback string
- **Command Search Styling**: Fixed input styling, note type icons, sidebar spacing, and added deleted_at column support
- **Onboarding Accessibility UX**: Show device name in mic settings and improve accessibility permission guidance
- **Orphaned Trial Note**: Removed orphaned trialNote reference from free plan pricing
- **Portal-Based Tooltips**: Fixed tooltip positioning and replaced download action with reveal-in-folder
- **State-Aware Media Pause**: Don't unpause media that was already paused before dictation started
- **WebSocket Audio Buffering**: Parallelized WebSocket connection and audio capture, buffer early audio to prevent data loss at meeting start
- **Video Track Loopback**: Keep video tracks alive for loopback audio capture, remove invalid dispose call

## [1.5.5] - 2026-03-01

### Added

- **Mode-Aware File Size Validation**: Upload UI now enforces file size limits per transcription mode — local is unlimited, BYOK and Cloud free are capped at 25 MB, Cloud pro at 500 MB — with contextual messaging and CTA buttons (Create Account, Upgrade, Switch to Cloud)
- **Large File Chunking**: Files over 25 MB are automatically split via FFmpeg and transcribed in parallel with per-chunk progress reporting
- **Gemma 3 Local Models**: Added Gemma 3 (1B, 4B, 12B, 27B) to the local model registry with provider icon
- **Groq Model Updates**: Added new Groq models and removed deprecated ones (Maverick, Kimi K2 Instruct)
- **Notes Editor Formatting Shortcuts**: Cmd+B (bold), Cmd+I (italic), Cmd+E (code) keyboard shortcuts in the notes editor
- **Linux Wayland Paste Improvements**: Added ydotool support and improved wl-copy reliability for Wayland paste
- **Granular Build Scripts**: Added individual build target scripts for more flexible CI/CD

### Fixed

- **Fn/Globe Hotkey**: Fn key now correctly treated as equivalent to Globe key on macOS
- **GPU Activation**: Fixed GPU activation flow and Vulkan fallback behavior
- **Groq i18n**: Updated Groq model descriptions and added missing translations across all locales

## [1.5.4] - 2026-02-25

### Added

- **Auto-Learn Correction Monitoring**: Detects user edits after paste and automatically updates the custom dictionary with learned corrections; native text monitor binaries for macOS (AXObserver with PID-based AX targeting), Windows, and Linux (with download-first strategy and CI workflow for prebuilt binaries); undo button on auto-learned dictionary toast; dictionary settings UI with translations across all locales
- **Config-Driven STT Routing**: STT mode (batch vs streaming) now driven by `/api/stt-config` per context (dictation vs notes); streaming provider adapter map supports Deepgram and AssemblyAI, replacing hardcoded Deepgram IPC calls with a generic interface
- **Live Toggle in Notes**: "Live" toggle in NoteEditor lets users override between streaming and batch transcription for notes

### Fixed

- **STT Metadata Forwarding**: Forward complete STT metadata (`sttWordCount`, `sttLanguage`, actual Deepgram model, audio bytes, `stt_processing_ms`) and client end-to-end latency (`client_total_ms`) to API logging
- **BYOK Transcription Logging**: Fixed BYOK reasoning incorrectly suppressing transcribe logs

## [1.5.3] - 2026-02-24

### Added

- **Unified GPU Banners**: Replaced dual CUDA/Vulkan banners on the home screen with a single GPU acceleration banner; added GPU banners to Transcription Settings and AI Text Enhancement Settings
- **GpuStatusBadge Redesign**: Auto-retry flow (download → activating → GPU active) with 15s timeout, replacing confusing "CPU Only" and "Re-detect GPU" states; swapped hardcoded hex colors for `bg-success`/`bg-warning` design tokens
- **Streaming Usage Tracking**: Wired up the previously-uncalled `/api/streaming-usage` endpoint so Deepgram streaming transcriptions report word counts to the server
- **Cloud API Telemetry**: Forward STT metadata (`sttProvider`, `sttModel`, processing time, audio duration/size/format) and `clientVersion`/`clientType`/`appVersion` to all cloud API requests
- **Internationalization**: Added 15 missing i18n keys (`app.mic.*`, `app.commandMenu.*`, `app.toasts.*`, `app.oauth.*`, `notes.enhance.title`) across all 10 locale files

### Fixed

- **Windows Blank Screen**: Fixed blank screen on return from sleep/minimize by adding `render-process-gone` handler, `isCrashed()` health checks on show/tray/second-instance paths, `backgroundColor` and `backgroundThrottling` to window config, and `disable-gpu-compositing` for win32
- **IPC Echo Loop**: Broke infinite IPC bounce in floating icon auto-hide toggle by guarding the setter with an early return when the value hasn't changed
- **GPU Banner Navigation**: GPU banner "Enable GPU" button now navigates to the correct `"intelligence"` settings section instead of invalid `"reasoning"` ID
- **AI CTA Deep Link**: Replaced legacy `"aiModels"` alias with canonical `"intelligence"` section ID in the AI enhancement CTA button
- **Custom Endpoint Routing** (#311): Moved `reasoningProvider === "custom"` check to the top of `getModelProvider()` so custom endpoint models are never misrouted through built-in providers; custom models now show a neutral Globe icon
- **KDE Wayland Terminal Detection**: Detect Konsole via `kdotool` (fast path) or KWin `supportInformation` via `qdbus` (zero-install fallback) so terminals receive `Ctrl+Shift+V` instead of `Ctrl+V`
- **RAM Leak on Provider Switch**: Whisper, Parakeet, and llama-server processes now stop when switching to cloud providers, freeing loaded models from RAM
- **Streaming Usage Session Refresh**: Wrapped `cloudStreamingUsage` in `withSessionRefresh` so expired sessions auto-refresh instead of silently dropping word counts
- **Duplicate Transcription Logs**: Skip telemetry logging in streaming-usage and transcribe endpoints when reasoning is enabled (the `/api/reason` endpoint already creates the combined row)
- **Usage Cache Invalidation**: `useUsage` hook now listens for `usage-changed` events to invalidate its cache and refetch immediately after transcription
- **macOS Binary Architecture**: Added Mach-O header verification to globe-listener and fast-paste build scripts; force rebuild when architecture-specific hash file is missing; runtime architecture check before spawning binary
- **Globe Key Listener Resilience**: Auto-restart globe key listener on unexpected exit code 0 (sleep/wake invalidation); reset restart counter after sustained uptime; only treat "Failed to create event tap" as fatal
- **Parakeet Long Recordings**: Lowered max segment duration from 30s to 15s for more reliable chunked transcription; downgraded reasoning failure log from error to warn

## [1.5.2] - 2026-02-24

### Fixed

- **Reasoning Output**: Resolved empty output for Qwen3/GPT-OSS models by raising local inference minimum tokens from 100 to 512; fixed custom endpoint models misrouting by checking `reasoningProvider` setting before name heuristics
- **Google OAuth**: Added `newUserCallbackURL` to desktop Google OAuth flow for proper new user registration
- **Linux KDE Taskbar**: Prevented dictation panel from appearing in KDE taskbar
- **Intel Mac CI Builds**: Fixed binary architecture mismatch by installing x64 ffmpeg-static binary and preventing prebuild hooks from deleting x64 binaries on arm64 CI runners (#196)

## [1.5.1] - 2026-02-23

### Added

- **GPU-Accelerated Local Inference**: Vulkan (Windows/Linux) and Metal (macOS) support for llama-server with automatic CPU fallback and GPU status badge in the reasoning model selector
- **CUDA GPU Acceleration for Whisper**: NVIDIA GPU acceleration for local Whisper transcription with automatic GPU detection, upgrade banner for existing users, and shared download progress UI
- **On-Demand Vulkan Download**: Vulkan llama-server binary downloads on-demand when the user opts in, saving 40-46MB from the app installer

### Changed

- **Vulkan Llama-Server Architecture**: Switched from bundling the Vulkan binary to on-demand download into userData, mirroring the Whisper CUDA download pattern

### Fixed

- **macOS Paste Failure**: Replaced osascript-based accessibility check with Electron's native `isTrustedAccessibilityClient()` and fixed focus transfer using hide()+showInactive() instead of blur() on NSPanel (#313)
- **Windows Sherpa-onnx Extraction**: Fixed tar extraction failing on Windows due to GNU tar interpreting drive letter colons as remote host separators — now uses relative paths (#284)
- **macOS Auto-Update Architecture**: Detect Rosetta translation via `sysctl.proc_translated` so Apple Silicon users stuck on an x64 build from older releases self-heal to the native arm64 build on next update

## [1.5.0] - 2026-02-23

### Added

- **Notes System**: Full-featured note-taking built into the control panel
  - Create, edit, and organize notes with a rich Markdown editor
  - Organize notes into custom folders with a default Personal folder
  - Upload audio files for transcription directly into notes
  - Real-time dictation widget for transcribing directly into a note
  - Drag-and-drop to reorder notes and move between folders
  - Guided onboarding flow for first-time notes users
- **AI Actions on Notes**: Apply AI-powered actions to note content
  - Action picker with customizable processing prompts
  - Action manager dialog for creating and editing action templates
  - Processing overlay with live progress feedback
- **Sidebar Navigation**: Redesigned control panel with persistent sidebar
  - New `ControlPanelSidebar` replaces the old tab-based layout
  - Dedicated views for History, Notes, Dictionary, and Settings
  - Collapsible sidebar for more content space
- **Referral Program**: Invite friends to earn free Pro months
  - Referral dashboard with invite tracking and status badges
  - Email invitation flow
  - Animated spectrogram share card with unique referral code
- **New AI Models**: Added Claude 4.6 (Opus), Gemini 3 Flash, and Gemini 3.1 Pro to the model registry
- **Settings Store**: Migrated settings state management to Zustand store for better performance and shared access across components
- **Note Store & Action Store**: New Zustand stores for notes and AI action state

### Changed

- **Control Panel Architecture**: Extracted History, Dictionary, and Settings into standalone views, reducing ControlPanel complexity
- **Settings Refactor**: Extracted bulk of `useSettings` hook logic into `settingsStore.ts` for cleaner separation of concerns
- **UI Polish**: Updated numerous components with improved dark mode support, consistent spacing, and refined typography
- **Locale Updates**: Extended all 10 language files with notes, referral, and sidebar translation keys

### Fixed

- **macOS Auto-Update Architecture**: Detect Rosetta translation via `sysctl.proc_translated` so Apple Silicon users stuck on an x64 build from older releases self-heal to the native arm64 build on next update
- **Linux GTK Crash**: Force GTK3 on Linux startup to avoid GTK symbol crash on systems with GTK4 installed (#291)
- **CI Pipeline**: Added Windows paste binary and key listener download steps to the build workflow (#298)
- **Buy Me a Coffee**: Updated funding link username

## [1.4.11] - 2026-02-13

### Added

- **Japanese Locale**: Full Japanese UI and prompt translations
- **Windows Paste Terminal Detection**: Added kitty to the Windows fast paste binary's terminal class list

### Changed

- **Windows Push-to-Talk Refactor**: Moved PTT state management (hold timing, recording tracking, cooldown) from main process into `windowManager` for cleaner separation and consistency with macOS PTT patterns
- **Audio Recording Reentrancy Guards**: Added lock refs to `useAudioRecording` start/stop to prevent concurrent calls from rapid key presses
- **Synchronous Activation Mode**: `getActivationMode()` is now synchronous (reads from cache), removing unnecessary async overhead in all PTT and hotkey handlers
- **Default Agent Name**: Set default agent name to OpenWhispr

### Fixed

- **Hide vs Minimize**: Dictation panel now consistently hides (rather than minimizing on Windows/Linux) for uniform cross-platform behavior
- **Minimized Window Restore**: Dictation panel restores from minimized state before showing, preventing invisible panel on Windows

## [1.4.10] - 2026-02-13

### Added

- **Deepgram Streaming Liveness Check**: Detects unresponsive warm connections within 2.5s and transparently reconnects with audio replay
- **Batch Transcription Fallback**: If streaming produces no text, automatically falls back to batch transcription via OpenWhispr Cloud
- **Full Locale Codes**: Pass full locale codes (e.g. en-US, zh-CN) to Deepgram instead of stripping to base codes, preserving dialect precision

### Fixed

- **Deepgram Token Expiry**: Fixed token expiry clock resetting on every re-warm cycle, which prevented detection of expired tokens and caused persistent 401 errors
- **Deepgram 401 Recovery**: Invalidate cached tokens on authentication failures so subsequent attempts fetch fresh tokens instead of retrying stale ones

## [1.4.9] - 2026-02-12

### Fixed

- **Deepgram Nova-3 Language Fallback**: Automatically fall back to Nova-2 for languages not yet supported by Nova-3 (e.g., Chinese, Thai), preventing 400 Bad Request errors. Also switches from `keyterm` to `keywords` parameter when using Nova-2.

## [1.4.8] - 2026-02-12

### Added

- **Referral Program**: Invite friends to earn free Pro months with referral dashboard, email invitations, invite tracking with status badges, and animated spectrogram share card with unique referral code
- **Notes System**: Added sidebar navigation with notes system and dictionary view for organizing transcriptions
- **Folder Organization**: Notes can be organized into custom folders with a default Personal folder, folder management UI, and folder-aware note filtering. Upload flow now includes folder selection
- **Internationalization v1**: Full desktop localization across auth, settings, hooks, and UI with centralized renderer locale resources (#258)
- **Chinese Language Split**: Split Chinese into Simplified (zh-CN) and Traditional (zh-TW) with tailored AI instructions and one-time migration for existing users (#267)
- **Russian Interface Language**: Added Russian to interface language options
- **Deepgram Token Refresh & Keyterms**: Proactive token rotation for warm connections before expiry and keyterms pass-through for improved transcription accuracy

### Fixed

- **macOS Non-English Keyboard Paste**: Fixed paste not working on non-English keyboard layouts (Russian, Ukrainian, etc.) by using physical key code instead of character-based keystroke in AppleScript fallback
- **Whisper Language Auto-Detection**: Pass `--language auto` to whisper.cpp explicitly so non-English audio isn't forced to English (#260)
- **Model Download Pipeline**: Inline redirect handling, deferred write stream creation, indeterminate progress bar for unknown sizes, and Parakeet ONNX file validation after extraction
- **Sherpa-onnx Shared Libraries**: Always overwrite shared libraries during download to prevent stale architecture-mismatched binaries, with `--force` support
- **Chinese Translation Fixes**: Minor translation corrections for Chinese interface strings
- **Neon Auth Build Config**: Fixed auth build configuration

## [1.4.7] - 2026-02-11

### Added

- **Deepgram Streaming Transcription**: Migrated real-time streaming transcription from AssemblyAI to Deepgram for improved reliability and accuracy (#249)

### Fixed

- **BYOK After Upgrade**: Prefer localStorage API keys over process.env so Bring Your Own Key mode works correctly after upgrading (#263)
- **PTT Double-Fire Prevention**: Applied post-stop cooldown and press-identity checks to both macOS and Windows push-to-talk handlers
- **Archive Extraction Retry**: Reuse existing archive on extraction retry with improved error handling
- **Email Verification Polling**: Pass email param in verification polling and stop on 401 responses
- **Auth Build Bundling**: Added @neondatabase/auth packages to rollup externals for correct production bundling (#256)
- **Neon Auth Build Config**: Fixed Vite build configuration for Neon Auth packages (#266)

### Changed

- **Build System**: Bumped Node version in build files

## [1.4.6] - 2026-02-10

### Added

- **Robust Model Downloads**: Hardened download pipeline with stall detection, disk space checks, and file validation for more reliable model installs
- **Prompt Handling Improvements**: Improved agent name resolution, prompt studio enhancements, and smarter prompt context assembly
- **Past-Due Subscription Handling**: Users with past-due subscriptions now see clear messaging and recovery options

### Fixed

- **Parakeet Long Audio**: Fixed empty transcriptions for long audio by segmenting input before sending to Parakeet
- **Plus-Addressed Emails**: Reject plus-addressed emails (e.g., user+tag@example.com) during authentication
- **Double-Click Prevention**: Prevent duplicate requests when double-clicking checkout and billing buttons
- **Auth Initialization Race**: Await init-user before completing auth flow and fix missing user dependency

### Changed

- **Startup Performance**: Preload lazy chunks during auth initialization for faster page transitions
- **Code Cleanup**: Removed excess comments and simplified window management logic

## [1.4.5] - 2026-02-09

### Added

- **Dictation Sound Effects Toggle**: New setting to enable/disable dictation audio cues with refined tones (warmer, softer frequencies, gentler attack, distinct start/stop)
- **Toast Notification Redesign**: Redesigned toast notifications as dark HUD surfaces for a more polished look
- **Floating Icon Auto-Hide**: New setting to auto-hide the floating dictation icon
- **Loading Screen Redesign**: Branded loading screen with logo and spinner
- **Discord Support Link**: Added Discord link to the support menu
- **Auth-Aware Routing**: Returning signed-out users now see a re-authentication screen instead of a broken state

### Fixed

- **Dropdown Dark Mode**: Fixed dropdown styling in dark mode
- **Toast Dark Mode**: Fixed toast colouring in dark mode
- **Globe Key Persistence**: Globe key now persists to .env and dictation key syncs to localStorage
- **Globe Listener Cross-Compilation**: Cross-compiled globe listener for x64

### Changed

- **Startup Performance**: Deferred non-critical manager initialization after window creation, lazy-loaded ControlPanel/OnboardingFlow/SettingsModal, converted env file writes to async, extracted SettingsProvider context, and split Radix/lucide into separate vendor chunks
- **Scrollbar Styling**: Subtle transparent-track scrollbar with thinner floating thumb

## [1.4.4] - 2026-02-08

### Fixed

- **AI Enhancement CTA Persistence**: Dismissing the "Enable AI Enhancement" banner now persists to localStorage so it stays hidden across sessions

### Changed

- **Code Cleanup**: Removed excess comments and section dividers in ControlPanel

## [1.4.3] - 2026-02-08

### Added

- **Mistral Voxtral Transcription**: Added Mistral as a cloud transcription provider with Voxtral Mini model and custom dictionary support via context_bias
- **TypeScript Compilation**: Added TypeScript as an explicit dev dependency with project-level `tsconfig.json`

### Fixed

- **Linux Wayland Clipboard**: Persistent clipboard ownership on Wayland so Ctrl+V works reliably after transcription
- **Linux Window Flickering**: Fixed transparent window flickering on Wayland and X11 compositors
- **Windows Modifier-Only Hotkeys**: Support modifier-only hotkeys on Windows via native keyboard hook
- **Update Installation**: Resolved quitAndInstall hang by removing close listeners that block window shutdown during updates
- **Custom System Prompts**: Pass custom system prompt to local and Anthropic BYOK reasoning
- **Audio Cue Audibility**: Improved dictation start/stop audio cue volume
- **Language Selector**: Fixed dropdown positioning and sizing inside settings modal
- **Type Safety**: Tightened Electron IPC callback return types, model picker styles, toast variant types, and event handler signatures across the codebase

### Changed

- **Code Cleanup**: Removed excess comments, section dividers, and redundant JSDoc across components, hooks, and utilities

## [1.4.2] - 2026-02-07

### Fixed

- **AssemblyAI Streaming Reliability**: Fixed real-time WebSocket going silent after idle periods by adding keep-alive pings, readyState validation, re-warm recovery, and connection death handling

## [1.4.1] - 2026-02-07

### Added

- **Runtime .env Configuration**: Environment variables now reload at runtime without requiring app restart
- **Settings Retention on Pro**: Pro subscribers retain their settings when managing their subscription

### Fixed

- **macOS Microphone Permission**: Resolved hardened-runtime mic permission prompt by routing through main-process IPC and unifying API key cache invalidation with event-based AudioManager sync
- **AudioWorklet ASAR Loading**: Inlined AudioWorklet as blob URL to fix module loading failure in packaged ASAR builds
- **Google OAuth Flow**: OAuth now opens in the system browser with deep link callback instead of navigating the Electron window
- **Auth Security Hardening**: Safe JSON parsing, guarded URL constructor, and fixed error information leaks in auth code
- **Deep Link Focus**: Control panel now correctly receives focus when opened via deep link
- **Neon Auth Electron Compatibility**: Routed auth flows through API proxy and fixed Origin header rejection for desktop app
- **Billing Error Visibility**: Checkout and billing errors now surface as toast notifications instead of failing silently
- **Hotkey Persistence**: Added file-based hotkey storage for reliable startup persistence (#181)
- **Email Verification**: Disabled Neon Auth email verification step for smoother onboarding

### Changed

- **Build Optimization**: Binary dependencies are now cached during build for faster CI
- **UI Polish**: Fixed scrollbar styling, provider button styling, and voice recorder icon fill

## [1.4.0] - 2026-02-06

### Added

- **OpenWhispr Cloud**: Cloud-native transcription service — sign in and transcribe without managing API keys
  - Google OAuth and email/password authentication via Neon Auth
  - Email verification flow with polling and resend support
  - Password reset via email magic links
- **Subscription & Billing**: Free and Pro plans with Stripe-powered payments
  - Free plan with rolling weekly word limits (2,000 words/week)
  - Pro plan with unlimited transcriptions
  - 7-day free trial for new accounts with countdown display
  - In-app upgrade prompts when approaching or reaching usage limits
  - Stripe billing portal access for Pro subscribers
- **Usage Tracking**: Real-time usage display with progress bar, color-coded thresholds, and next billing date
- **Account Section in Settings**: Profile display, plan status badge, usage bar, billing management, and sign out
- **Upgrade Prompt Dialog**: When usage limit is reached, offers three paths — upgrade to Pro, bring your own key, or switch to local
- **Cancel Processing Button**: Cancel ongoing transcription processing mid-flight
- **Dynamic Window Resizing**: Window automatically resizes based on command menu and toast visibility
- **Dark Mode Icon Inversion**: Monochrome provider icons now automatically invert in dark mode for better visibility

### Changed

- **Onboarding Redesign**: Auth-first onboarding flow
  - Signed-in users get a streamlined 3-step flow (Welcome → Setup → Activation)
  - Non-signed-in users get a 4-step flow with transcription mode selection
  - Permissions merged into Setup step for signed-in users
- **Transcription Mode Architecture**: Unified mode selection across OpenWhispr Cloud, Bring Your Own Key (BYOK), and Local
  - Signed-in users default to OpenWhispr Cloud
  - Non-signed-in users choose between BYOK and Local
- **Design System Overhaul**: Complete refactor of styling to use design tokens throughout the codebase
  - Button component now uses `text-foreground`, `bg-muted`, `border-border` instead of hardcoded hex values
  - Removed hardcoded classes and inline styles across components
  - Improved button and badge consistency
- **Settings UI Redesign**: Overhauled all settings pages with unified panel system, redesigned sidebar, and extracted permissions section
- **Dark Mode Polish**: Premium button styling, glass morphism toasts, and streamlined visuals
- **App Channel Isolation**: Development, staging, and production channels now use isolated user data directories

### Fixed

- **Light Mode UI Visibility**: Fixed multiple UI elements that were invisible or hard to see in light mode:
  - Settings gear icon in permission cards now uses `text-foreground`
  - Troubleshoot button uses proper foreground color
  - Reset button in developer settings now correctly shows destructive color
  - Settings and Help icons in the toolbar are now properly visible
  - Check for Updates button now renders correctly in light mode
- **Provider Tab Flashing**: Resolved TranscriptionModelPicker tab flashing by extracting ModeToggle component and syncing internal state with props
- **Local Reasoning Model Persistence**: Fixed local reasoning model selection not persisting correctly
- **Parakeet Model Status**: Added dedicated IPC channel for Parakeet model status checks
- **Groq Qwen3 Models**: Removed thinking tokens from Qwen3 models on Groq provider
- **OAuth Session Grace Period**: Automatic session refresh with exponential backoff retry during initial OAuth establishment

## [1.3.3] - 2026-01-28

### Added

- **ONNX Warm-up Inference**: Parakeet server now runs warm-up inference on start to eliminate first-request latency from JIT compilation
- **Startup Preferences Sync**: Renderer startup preferences are now synced to `.env` for server pre-warming on restart

### Changed

- **macOS Tray Behavior**: Hide to tray on macOS for consistent cross-platform behavior

### Fixed

- **macOS Launch Crash**: Added `disable-library-validation` entitlement to resolve macOS launch crash (#120)
- **Reasoning Model Default**: Fixed `useReasoningModel` not correctly defaulting to enabled by persisting useLocalStorage defaults and aligning direct reads
- **Windows Non-ASCII Usernames**: Resolved whisper-server crash on Windows with non-ASCII usernames by pre-converting audio to WAV and routing temp files through ASCII-safe directory
- **Windows Paths with Spaces**: Fixed temp directory fallback to also detect paths with spaces on Windows

## [1.3.2] - 2026-01-27

### Changed

- **Linux Paste Tools**: Prefer xdotool over ydotool for better compatibility

### Fixed

- **Windows Zip Extraction**: Use tar instead of PowerShell Expand-Archive for zip extraction on Windows to avoid issues with special characters

## [1.3.1] - 2026-01-27

### Changed

- **Download System Refactor**: Consolidated model download logic into shared utilities with resume support, retry logic, abort signals, and improved installing state UI
- **Throttled Progress Display**: Whisper model download progress updates are now throttled for smoother UI

## [1.3.0] - 2026-01-26

### Added

- **NVIDIA Parakeet Support**: Fast local transcription via sherpa-onnx runtime with INT8 quantized models
  - `parakeet-tdt-0.6b-v3`: Multilingual (25 languages), ~680MB
- **Windows Push-to-Talk**: Native Windows key listener with low-level keyboard hook for true push-to-talk functionality
  - Supports compound hotkeys like `Ctrl+Shift+F11` or `CommandOrControl+Space`
  - Prebuilt binary automatically downloaded from GitHub releases
  - Fallback to tap mode if binary unavailable
- **Custom Dictionary**: Improve transcription accuracy for specific words, names, and technical terms
  - Add custom words through Settings → Custom Dictionary
  - Words are passed as hints to Whisper for better recognition
  - Works with both local and cloud transcription
- **GitHub Actions Workflow**: Automated CI workflow to build and release Windows key listener binary
- **Shared Download Utilities**: New `scripts/lib/download-utils.js` module with reusable download, extraction, and GitHub release fetching functions

### Changed

- **Download Scripts Refactored**: All download scripts now use shared utilities for consistency
- **GitHub API Authentication**: Download scripts support `GITHUB_TOKEN` to avoid API rate limits in CI
- **Debug Logging Cleanup**: Extracted common window loading code and cleaned up debug logging

### Fixed

- **GNOME Wayland Hotkey Improvements**: Improved hotkey handling on GNOME Wayland
- **Hotkey Persistence**: Fixed hotkey selection not persisting correctly
- **Custom Endpoint API Keys**: Fixed custom endpoint API keys not persisting to `.env` file
- **Custom Endpoint State**: Fixed custom endpoint using shared state instead of its own
- **Linux Stale Hotkey Registrations**: Clear stale hotkey registrations on startup on Linux
- **Wayland XWayland Paste**: Try xdotool on Wayland when XWayland is available
- **llama-server Libraries**: Bundle llama-server shared libraries and search from extract root for varying archive structures
- **STT/Reasoning Debug Logging**: Added missing debug logging for STT and reasoning pipelines

## [1.2.16] - 2026-01-24

### Fixed

- **App Startup Hang**: Fixed app initialization timing issues with Electron 36+
- **Manager Initialization**: Deferred manager initialization until after `app.whenReady()` to prevent hangs
- **Debug Logger Initialization**: Deferred debugLogger file initialization until `app.whenReady()`
- **Config Bundling**: Fixed missing config files in production builds
- **whisper.cpp Binary Version**: Updated whisper.cpp release names and bumped binary version

## [1.2.15] - 2026-01-22

### Added

- **ydotool Fallback for Linux**: Added ydotool as additional fallback option for clipboard paste operations on Linux systems

### Changed

- **Unified Prompt System**: Refactored to single intelligent prompt system for improved consistency and maintainability
- **whisper.cpp Remote**: Refactored remote whisper.cpp integration for better reliability

## [1.2.14] - 2026-01-22

### Added

- **Troubleshooting Mode**: New debug logging section in settings with toggle for detailed diagnostic logs, log file path display, and direct folder access for easier support
- **Custom Transcription Endpoint**: Support for custom OpenAI-compatible transcription endpoints with configurable base URLs
- **Enhanced Clipboard Debugging**: Detailed clipboard operation logging for diagnosing paste issues across platforms

### Changed

- **API Key Management**: Consolidated and refactored API key persistence with improved .env file handling and recovery mechanisms
- **Local Network Detection**: Refactored URL detection into reusable utility for better code organization
- **Electron Builder**: Updated to latest version for improved build performance

### Fixed

- **Windows/Linux Taskbar**: Prevented dual taskbar entries on Windows and Linux by properly configuring window behavior
- **Single Instance Lock**: Enforced single instance lock with cleaner window state checks
- **Model Provider Consistency**: Removed redundant fallbacks and ensured consistent use of getModelProvider()
- **Cross-env Support**: Fixed Windows compatibility in pack script using cross-env
- **Linux X11 Paste**: Improved paste reliability by capturing target window ID upfront with windowactivate --sync, added xdotool type fallback for terminals
- **Tray Minimize**: Fixed minimize to tray functionality

## [1.2.12] - 2026-01-20

### Added

- **LLM Download Cancellation**: Added ability to cancel in-progress local LLM model downloads with throttled progress updates to prevent UI flashing

### Changed

- **Gemini Model Updates**: Updated Gemini models to latest versions
- **Linux Wayland Improvements**: Improved Wayland paste detection with GNOME-specific handling and XWayland fallback support
- **whisper.cpp CUDA Support**: Updated whisper.cpp download script to include CUDA-enabled binaries

### Fixed

- **Windows Paste Delay**: Adjusted paste delay timing on Windows for more reliable text insertion
- **Blank Audio Prevention**: Fixed issue where blank/silent audio recordings would paste empty text
- **Newline Handling**: Fixed newline formatting issues in transcribed text

## [1.2.11] - 2026-01-18

### Fixed

- **ASAR Path Resolution**: Fixed path resolution issues for bundled resources in packaged builds
- **Update Checker**: Fixed auto-update checker initialization
- **Build Includes**: Ensured services and models are properly included in production builds
- **OS Module Import**: Fixed OS module import ordering

## [1.2.10] - 2026-01-17

### Fixed

- **Streaming Backpressure**: Fixed proper streaming backpressure handling in audio processing
- **Quit and Install**: Fixed update installation on app quit

## [1.2.9] - 2026-01-17

### Fixed

- **Path Resolution**: Improved path resolution for better cross-platform compatibility

## [1.2.8] - 2026-01-16

### Added

- **Microphone Input Selection**: Choose your preferred microphone input device in settings, with built-in mic preference to prevent Bluetooth audio interruptions
- **Push to Talk Mode**: New recording mode option alongside the existing toggle mode
- **Hotkey Listening Mode**: Prevents conflicts when capturing new hotkeys by temporarily disabling the global hotkey
- **Hotkey Fallback System**: Automatic fallback with user notifications when preferred hotkey is unavailable
- **Cross-Platform Accessibility Settings**: Quick access to system accessibility settings on macOS

### Changed

- **Streamlined Onboarding**: Removed redundant "How it Works" section, success dialogs, and manual save buttons for a smoother setup experience
- **Improved Select Styling**: Enhanced dropdown select component appearance

### Fixed

- **FFmpeg Availability Types**: Corrected type definitions and optimized whisper-cpp download process
- **Whisper Models Path**: Fixed model storage path resolution
- **Better Path Resolution**: Improved error handling for file paths
- **Open Mic Settings**: Fixed system settings link for microphone configuration

## [1.2.7] - 2026-01-13

### Added

- **Whisper Server HTTP Mode**: Added persistent whisper-server for faster repeated transcriptions with automatic CLI fallback
- **Pipeline Timing Instrumentation**: Added detailed timing logs for each stage of the transcription pipeline
- **Whisper Server Pre-warming**: Server pre-warms on startup for faster first transcription

### Changed

- **Windows Clipboard**: Reduced clipboard delays for faster text pasting on Windows

### Fixed

- **Windows Update Install**: Simplified Windows update installation by using silent mode and removing redundant before-quit handling
- **Mac Build Workflows**: Fixed CI/CD to run separate workflows for Mac builds
- **Mac DMG Build Race Condition**: Fixed release workflow DMG build failure caused by concurrent arm64/x64 builds mounting same volume
- **Windows Download Script**: Fixed PowerShell Expand-Archive failure with bracket characters in directory names

## [1.2.6] - 2026-01-13

### Changed

- **Settings Layout**: Moved settings navigation to left side on Windows and Linux for improved consistency

### Fixed

- **Linux Whisper Detection**: Fixed issue where Python-based Whisper could be used instead of whisper.cpp on Linux systems

## [1.2.5] - 2026-01-13

### Added

- **Model Validation**: Added validation when deleting or loading Whisper models to ensure model integrity
- **Download Cancellation**: Added ability to cancel in-progress model downloads in whisper pickers
- **Windows Paste Performance**: Added nircmd for faster text pasting on Windows

### Fixed

- **EventEmitter Memory Leak**: Fixed memory leak caused by duplicate listener registration in useUpdater hook across ControlPanel and SettingsPage components
- **FFmpeg Path Resolution**: Fixed FFmpeg path resolution in unpacked ASAR for local whisper.cpp transcription

### Changed

- **UI Cleanup**: Removed redundant UI elements for a cleaner interface

## [1.2.4] - 2026-01-13

### Changed

- **whisper.cpp Packaging**: Moved whisper.cpp binaries from ASAR to extraResources for improved reliability and faster startup

### Fixed

- **Package Lock Sync**: Fixed package-lock.json synchronization with package.json dependencies

## [1.2.3] - 2026-01-13

### Added

- **Extended Hotkey Support**: Added numpad keys, media keys, and additional special keys (Pause, ScrollLock, PrintScreen, NumLock) for hotkey selection
- **Improved Hotkey Error Messages**: Registration failures now include helpful suggestions for alternative hotkeys

### Changed

- **Linux Paste Tools**: Only show paste tools installation prompt on Linux when tools are not available

### Fixed

- **Hotkey Debugging**: Added comprehensive debug logging to hotkey manager for troubleshooting registration issues

## [1.2.2] - 2026-01-13

### Fixed

- **React Version Mismatch**: Fixed blank screen caused by incompatible React and React-DOM versions in package-lock.json

## [1.2.1] - 2026-01-13

### Fixed

- **Blank Screen on Upgrade**: Fixed white screen issue for users upgrading from older versions with different onboarding step counts. The onboarding step index is now properly clamped to valid range.

## [1.2.0] - 2026-01-13

### Added

- **Delete All Whisper Models**: New option to delete all downloaded Whisper models at once
- **Model Deletion Confirmation**: Added confirmation dialog when deleting models in settings

### Changed

- **Migrated to whisper.cpp**: Replaced Python-based Whisper with native whisper.cpp for faster, more reliable transcription
  - No longer requires Python installation
  - WebM-to-WAV audio conversion built-in
  - Significantly improved startup and transcription speed
- **Streamlined Onboarding**: Simplified setup flow with fewer steps now that Python is not required
- **Download Cancellation**: Added ability to cancel in-progress model downloads
- **CI/CD Updates**: Updated build and release workflows

### Fixed

- **IPC Handler**: Fixed broken IPC handler for model operations
- **Logging**: Standardized logging across the application
- **React Hook Dependencies**: Improved React hook dependency arrays for better performance
- **Button Styling**: Fixed button styling consistency across the application

### Removed

- **Python Dependency**: Removed Python requirement and all related installation code
- **whisper_bridge.py**: Removed Python-based Whisper bridge in favor of native whisper.cpp

## [1.1.2] - 2026-01-12

### Added

- **Linux Package Dependencies**: Recommended xdotool, wtype, and python3 packages for Linux users

### Fixed

- **Python Installation Race Condition**: Fixed race condition in Python installation check that could cause installation to fail or hang

## [1.1.1] - 2026-01-12

### Added

- **Cross-Platform Paste Tools Detection**: Onboarding now detects and guides users through installing paste tools on Linux and Windows with auto-grant accessibility

### Changed

- **Qwen Model Compatibility**: Disabled thinking mode for Qwen models on Groq to prevent compatibility issues
- **Model Registry Refactor**: disableThinking flag now uses the centralized model registry
- **Consolidated ColorScheme Types**: Removed redundant default exports and cleaned up inline font styles
- **Provider Icons**: Use static imports for provider icons to fix Vite bundling issues

### Fixed

- **Recording Cancellation**: Restored cancel recording functionality that was accidentally removed
- **Model Downloads**: Implemented atomic downloads with temp file pattern and robust cleanup handling for cross-platform reliability
- **Incomplete Download Prevention**: Model file size validation now prevents incomplete downloads from showing as complete
- **Windows PowerShell Performance**: Optimized paste startup time on Windows

## [1.1.0] - 2026-01-10

### Added

- **Compound Hotkey Support**: Use multi-key combinations like `Cmd+Shift+K` or `Ctrl+Alt+D` for dictation
- **Groq API Integration**: Ultra-fast AI inference with Groq's cloud API
- **Auto-Update UI**: Download progress bars and install button in settings
- **Recording Cancellation**: Cancel an in-progress recording without transcribing
- **Release Notes Viewer**: Markdown-rendered release notes in settings

### Changed

- **Major Hotkey Refactor**: Complete rewrite of hotkey selection with improved reliability and validation
- **Consolidated Model Registry**: Single source of truth for all AI models (`modelRegistryData.json`)
- **Unified Model Picker**: Reusable component for both transcription and reasoning model selection
- **Improved Latency Logging**: Numbered stage logs for recording, transcription, reasoning, and paste timing
- **Reduced Paste Delay**: Lowered from 100ms to 50ms for faster text insertion
- **Code Quality**: Added ESLint, Prettier for JS/TS, and Ruff for Python

### Fixed

- **Windows 11 Compatibility**: Fixed PATH separator, cache directories, and process termination
- **Python Virtual Environment**: Fixed race condition and added Arch Linux venv support
- **Microphone Detection**: Improved onboarding flow for missing inputs with deep-linking to system settings
- **Recording State Alignment**: Recording now aligns to MediaRecorder's actual start/stop events
- **Caching Optimizations**: Cached accessibility, paste tool, and FFmpeg checks to reduce process spawns
- **Window Titles**: Electron window titles now set correctly after page load

## [1.0.15] - 2026-01-05

### Added

- Button to fully quit OpenWhispr processes from the application
- Linux terminal detection with automatic paste key switching (Ctrl+Shift+V for terminals)

### Changed

- Standardized logging on log levels with renderer IPC and `.env` refresh for consistent debug output

### Fixed

- Use `kdotool` for Wayland terminal detection, improving clipboard paste reliability
- Increased delay before restoring clipboard to avoid race conditions during paste operations
- Persist OpenAI key before onboarding test to prevent key loss during setup
- Windows Python discovery now correctly handles output parsing
- Keep FFmpeg debug schema as boolean type
- Fixed OpenWhispr documentation paths
- Windows: Resolved issue #16 with WAV validation, registry-based Python detection, and normalized FFmpeg paths

## [1.0.13] - 2025-12-24

### Added

- Enhanced Linux support with Wayland compatibility, multiple package formats (AppImage, deb, rpm, Flatpak), and native window controls
- Auto-detect existing Python during onboarding and gate the installer with a recheck option
- "Use Existing Python" skip flow to onboarding with confirmation dialog

### Changed

- Reuse audio manager and stabilize dictation toggle callback to fix recording latency
- Add cleanup functions to IPC listeners to prevent memory leaks
- Make Flatpak opt-in for local builds only

### Fixed

- Optimized transcription pipeline with caching, batched reads, and non-blocking operations for improved performance
- Reference error in settings page
- Removed redundant audio listener causing unnecessary processing
- Added IPC listener cleanup to prevent memory leaks
- Performance improvements: removed duplicate useEffect, fixed blur causing re-renders

### CI/CD

- Add caching for Electron and Flatpak downloads
- Add Flatpak runtime installation to workflow
- Add Linux packaging dependencies to GitHub Actions workflow

## [1.0.12] - 2025-11-13

### Added

- Added `scripts/complete-uninstall.sh` plus a new TROUBLESHOOTING guide so you can collect arch diagnostics, clean caches, and reset permissions before reinstalling stubborn builds.
- Control Panel history now auto-refreshes through a shared store and IPC events, so new, deleted, or cleared transcripts sync instantly without a manual refresh.
- Distribution artifacts now include both Apple Silicon and Intel macOS DMG/ZIP outputs, and the README documents Debian/Ubuntu packaging along with optional `xdotool` support.

### Changed

- The onboarding flow now validates dictation hotkeys before letting you continue, remembers whether cloud auth was skipped, and only persists sanitized API keys once supplied.
- History entries normalize timestamps and no longer run the removed legacy text cleanup helper, so the UI shows the exact Whisper output that was saved.

### Fixed

- Local Whisper now finds Python on Windows more reliably by scanning typical install paths, honoring `OPENWHISPR_PYTHON`, and surfacing actionable ENOENT guidance.
- Whisper installs automatically retry pip operations that hit PEP‑668, TOML, or permission errors, sanitizing the output and falling back to `--user` + legacy resolver when needed.

## [1.0.11] - 2025-10-13

### Added

- Settings, onboarding, and the AI model selector now accept OpenAI-compatible custom base URLs for both transcription and reasoning providers, complete with validation and reset helpers.
- Windows now gets full tray behavior: closing the control panel hides it to the tray, left-click reopens it, and the UI adds a native close button.

### Changed

- ReasoningService sends both `input` and `messages` payloads and automatically falls back between `/responses` and `/chat/completions` so older OpenAI-compatible endpoints keep working.

### Fixed

- Successful endpoint detection is cached per base URL, so the app remembers whether to call `/responses` or `/chat/completions` instead of retrying the wrong path forever.
- Custom endpoint fields now enforce HTTPS (with localhost as the lone exception) across the UI and services, preventing API keys from ever leaving over plain HTTP.

## [1.0.10] - 2025-10-07

### Added

- Added a `compile:globe` build step that emits a macOS Globe listener binary into `resources/bin` before every dev, pack, or dist command so the hotkey ships with all builds.

### Fixed

- Globe key failures now raise a macOS dialog, verify the bundled binary is executable, and kill/restart the listener cleanly so the shortcut survives packaging.

## [1.0.9] - 2025-10-07

### Changed

- Simplified the release workflow by removing the bespoke GitHub release job and letting electron-builder upload draft releases directly.

## [1.0.8] - 2025-10-03

### Fixed

- Globe/Fn hotkey reliability improved by showing the dictation panel before toggling, making focus optional, and surfacing listener spawn errors instead of failing silently.

## [1.0.7] - 2025-10-03

### Added

- Settings update controls now show download progress bars, install countdowns, and clearer messaging while fetching or installing new builds.

### Changed

- Auto-update internals now track listeners, cache the last release metadata, and keep auto-download/auto-install disabled until the user explicitly triggers an update, eliminating the previous memory leaks.

### Fixed

- `Install & Restart` now emits `before-quit`, enables `autoInstallOnAppQuit`, logs progress, and calls `quitAndInstall(false, true)` so updates actually apply when quitting or pressing the button.

## [1.0.6] - 2025-09-11

### Added

- **Dictation Panel Command Menu**: Clicking the floating panel reveals quick actions, including a one-click "Hide this for now" option.
- **macOS Globe Key Support**: Added a lightweight Swift listener so the Globe/Fn key can toggle dictation across the system.
- **Globe Key Selection UI**: Settings and onboarding keyboards now include a dedicated Globe key option.
- **Hotkey Validation**: Settings and onboarding now verify shortcut registration immediately, alerting users when a key can’t be bound.
- **Model Cache Cleanup**: Added an in-app command (and installer/uninstaller hooks) to delete all cached Whisper models.
- **Tray Controls**: macOS tray menu gained quick actions to show or hide the dictation panel.

### Changed

- **Dictation Overlay Placement**: Window now anchors to the active workspace's bottom-right corner with a safety margin, preventing it from sliding off-screen on multi-monitor setups.
- **Dictation Overlay Canvas**: Enlarged the floating window so tooltips, menus, and error states render without being clipped while keeping click-through behaviour outside interactive elements.
- **Keyboard UX**: Virtual keyboard hides macOS-exclusive keys on Windows/Linux and standardises hotkey labels.

### Fixed

- **macOS Window Lifecycle**: Ensured the dictation panel keeps the app visible in Dock and Command-Tab while retaining floating behaviour across spaces.
- **Control Panel Stability**: Reworked close/minimize handling so the panel stays interactive when switching apps and reopens cleanly without spawning duplicate windows.
- **Always-On-Top Enforcement**: Centralised the logic that reapplies floating window levels, eliminating redundant timers and focus quirks.
- **Menu Labelling**: macOS application menu items now display the correct OpenWhispr casing instead of "open-whispr".
- **Non-mac Hotkey Guard**: Prevented the mac-only Globe shortcut from being saved on Windows/Linux.

## [1.0.5] - 2025-09-10

### Fixed

- **Build System**: Fixed native module signing conflicts on macOS
  - Added `npmRebuild: true` to force rebuild of native modules during packaging
  - Added `buildDependenciesFromSource: true` to compile native dependencies from source
  - Added `better-sqlite3` to `asarUnpack` array to properly unpack SQLite3 native module
  - Resolves "different Team IDs" error when launching notarized macOS apps
- **CI/CD Pipeline**: Fixed automated release workflow issues
  - Removed automatic version update step from release workflow (version should be set before tagging)
  - Added `contents: write` permission to allow workflow to create GitHub releases
  - Fixes "Resource not accessible by integration" error during releases

### Technical Details

- This is a maintenance release focusing on build reliability and deployment infrastructure
- No feature changes or user-facing functionality updates
- All changes related to packaging, signing, and automated release processes

## [1.0.4] - 2025-09-09

### Added

- **Multi-Provider AI Support**: Integrated three major AI providers for text processing
  - OpenAI: Complete model suite including:
    - GPT-5 Series (Nano/Mini/Full) - Latest generation with deep reasoning
    - GPT-4.1 Series (Nano/Mini/Full) - Enhanced coding, 1M token context, June 2024 knowledge
    - o-series (o3/o3-pro/o4-mini) - Advanced reasoning models with extended thinking time
    - GPT-4o/4o-mini - Multimodal models with vision support
  - Anthropic: Claude Opus 4.1, Sonnet 4, and 3.5 variants for frontier intelligence
  - Google: Gemini 2.5 Pro/Flash/Flash-Lite and 2.0 Flash for advanced processing
- **OpenAI Responses API Integration**: Migrated from Chat Completions to the new Responses API
  - Simplified request format with `input` array instead of `messages`
  - New response parsing for `output` items with typed content
  - Automatic handling of model-specific requirements
  - Better support for GPT-5 and o-series reasoning models
- **Enhanced Reasoning Service**: Complete TypeScript rewrite with provider abstraction
  - Automatic provider detection based on selected model
  - Secure API key caching with TTL
  - Unified retry strategies across all providers
  - Provider-specific token optimization (up to 8192 for Gemini)
- **Comprehensive Debug Logging**: Enhanced reasoning pipeline with stage-by-stage logging
  - Provider selection and routing logs
  - API key retrieval and validation logs
  - Request/response details for all providers
  - Error tracking with full stack traces
- **Improved Settings UI**: Comprehensive API key management for all providers
  - Color-coded provider sections (OpenAI=green, Anthropic=purple, Gemini=blue)
  - Inline API key validation and secure storage
  - Provider-specific model selection with descriptions

### Changed

- **Default AI Model**: Updated from GPT-3.5 Turbo to GPT-4o Mini for cost-efficient multimodal support
- **Model Updates**: Refreshed all AI models to their latest 2025 versions
  - OpenAI: Added GPT-5 family (released August 2025), migrated to Responses API
  - Anthropic: Updated to Claude Opus 4.1 and Sonnet 4, fixed model naming
  - Gemini: Added latest 2.5 series models, increased token limits
- **ReasoningService**: Migrated from JavaScript to TypeScript for better type safety
- **API Endpoint Updates**:
  - OpenAI: Migrated from `/v1/chat/completions` to `/v1/responses`
  - Request format simplified for better performance
  - Response parsing updated for new output structure
- **Model Configuration Improvements**:
  - Fixed Anthropic model names (using hyphens instead of dots)
  - Increased Gemini 2.5 Pro token limits (2000 minimum)
  - Removed temperature parameter for GPT-5 and o-series models
- **Documentation**: Updated CLAUDE.md, README.md with comprehensive provider information

### Fixed

- **API Key Persistence**: All provider keys now properly save to `.env` file
  - Added `saveAllKeysToEnvFile()` method for consistent persistence
  - Keys reload automatically on app restart
  - Fixed Gemini and Anthropic key storage issues
- **CORS Issues**: Anthropic API calls now route through IPC handler
  - Avoids browser CORS restrictions in renderer process
  - Proper error handling in main process
- **Empty Response Handling**: Fixed "No text transcribed" error when AI returns empty
  - Falls back to original text when API returns nothing
  - Properly handles edge cases in response parsing
- **Parameter Compatibility**: Fixed OpenAI API parameter errors
  - GPT-5 models use simplified parameters (no max_tokens)
  - o-series models configured without temperature
  - Older models retain full parameter support

### Technical Improvements

- Added Gemini API integration with proper authentication flow
- Implemented SecureCache utility for API key management
- Enhanced IPC handlers for multi-provider support
- Updated environment manager with Gemini key storage
- Improved error handling with provider-specific messages
- Added comprehensive retry logic with exponential backoff
- Enhanced error messages with detailed logging
- Better fallback strategies for API failures
- Improved response validation and parsing
- Centralized API configuration in constants file
- Unified debugging system across all providers

## [1.0.3] - 2024-12-20

### Added

- **Local AI Models**: Integration with community models for complete privacy
  - Support for Llama, Mistral, and other open-source models
  - Local model management UI with download progress
  - Automatic model validation and testing
- **Enhanced Security**: Improved API key storage and management
  - System keychain integration where available
  - Encrypted localStorage fallback
  - Automatic key rotation support

### Fixed

- Resolved issues with Whisper model downloads on slow connections
- Fixed clipboard pasting reliability on Windows 11
- Improved error messages for better debugging
- Fixed memory leaks in long-running sessions

### Changed

- Optimized audio processing pipeline for 30% faster transcription
- Reduced app bundle size by 15MB through dependency optimization
- Improved startup time by lazy-loading heavy components

## [1.0.2] - 2024-12-19

### Added

- **Automatic Python Installation**: The app now detects and offers to install Python automatically
  - macOS: Uses Homebrew if available, falls back to official installer
  - Windows: Downloads and installs official Python with proper PATH configuration
  - Linux: Uses system package manager (apt, yum, or pacman)
- **Enhanced Developer Experience**:
  - Added MIT LICENSE file
  - Improved documentation for personal vs distribution builds
  - Added FAQ section to README
  - Added security information section
  - Clearer prerequisites and setup instructions
  - Added comprehensive CLAUDE.md technical reference
- **Dock Icon Support**: App now appears in the dock with activity indicator
  - Changed LSUIElement from true to false in electron-builder.json
  - App shows in dock on macOS with the standard dot indicator when running

### Changed

- Updated supported language count from 90+ to 58 (actual count in codebase)
- Improved README structure for better open source experience

## [1.0.1] - 2024-XX-XX

### Added

- **Agent Naming System**: Personalize your AI assistant with a custom name for more natural interactions
  - Name your agent during onboarding (step 6 of 8)
  - Address your agent directly: "Hey [AgentName], make this more professional"
  - Update agent name anytime through settings
  - Smart AI processing distinguishes between commands and regular dictation
  - Clean output automatically removes agent name references
- **Draggable Interface**: Click and drag the dictation panel to any position on screen
- **Dynamic Hotkey Display**: Tooltip shows your actual hotkey setting instead of generic text
- **Flexible Hotkey System**: Fixed hardcoded hotkey limitation - now fully respects user settings

### Changed

- **[BREAKING]** Removed click-to-record functionality to prevent conflicts with dragging
- **UI Behavior**: Recording is now exclusively controlled via hotkey (no accidental triggering)
- **Tooltip Text**: Shows "Press {your-hotkey} to speak" with actual configured hotkey
- **Cursor Styles**: Changed to grab/grabbing cursors to indicate draggable interface

### Fixed

- **Hotkey Bug**: Fixed issue where hotkey setting was stored but not actually used by global shortcut
- **Documentation**: Updated all docs to reflect current UI behavior and hotkey system
- **User Experience**: Eliminated confusion between drag and click actions

### Technical Details

- **Agent Naming Implementation**:
  - Added centralized agent name utility (`src/utils/agentName.ts`)
  - Enhanced onboarding flow with agent naming step
  - Updated ReasoningService with context-aware AI processing
  - Added agent name settings section with comprehensive UI
  - Implemented smart prompt generation for agent-addressed vs regular text
- Added IPC handlers for dynamic hotkey updates (`update-hotkey`)
- Implemented window-level dragging using screen cursor tracking
- Added real-time hotkey loading from localStorage in main dictation component
- Updated WindowManager to support runtime hotkey changes
- Added proper drag state management with smooth 60fps window positioning
- **Code Organization**: Extracted functionality into dedicated managers and React hooks:
  - HotkeyManager, DragManager, AudioManager, MenuManager, DevServerManager
  - useAudioRecording, useWindowDrag, useHotkey React hooks
  - WindowConfig utility for centralized window configuration
  - Reduced WindowManager from 465 to 190 lines through composition pattern

## [0.1.0] - 2024-XX-XX

### Added

- Initial release of OpenWhispr (formerly OpenWispr)
- Desktop dictation application using OpenAI Whisper
- Local and cloud-based speech-to-text transcription
- Real-time audio recording and processing
- Automatic text pasting via accessibility features
- SQLite database for transcription history
- macOS tray icon integration
- Global hotkey support (backtick key)
- Control panel for settings and configuration
- Local Whisper model management
- OpenAI API integration
- Cross-platform support (macOS, Windows, Linux)

### Features

- **Speech-to-Text**: Convert voice to text using OpenAI Whisper
- **Dual Processing**: Choose between local processing (private) or cloud processing (fast)
- **Model Management**: Download and manage local Whisper models (tiny, base, small, medium, large)
- **Transcription History**: View, copy, and delete past transcriptions
- **Accessibility Integration**: Automatic text pasting with proper permission handling
- **API Key Management**: Secure storage and management of OpenAI API keys
- **Real-time UI**: Live feedback during recording and processing
- **Global Hotkey**: Quick access via customizable keyboard shortcut
- **Database Storage**: Persistent storage of transcriptions with SQLite
- **Permission Management**: Streamlined macOS accessibility permission setup

### Technical Stack

- **Frontend**: React 19, Vite, TailwindCSS, Shadcn/UI components
- **Backend**: Electron 36, Node.js
- **Database**: better-sqlite3 for local storage
- **AI Processing**: OpenAI Whisper (local and API)
- **Build System**: Electron Builder for cross-platform packaging

### Security

- Local-first approach with optional cloud processing
- Secure API key storage and management
- Sandboxed renderer processes with context isolation
- Proper clipboard and accessibility permission handling
