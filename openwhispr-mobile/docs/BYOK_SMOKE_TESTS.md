# Personal BYOK release checks

This release offers exactly four: OpenAI, Groq, OpenRouter (text only) and Custom (any OpenAI-compatible server). All real-provider and physical-device results below are **unverified** until a maintainer records the device, OS, build commit, date, and sanitized result. Do not release based only on mocked tests or a successful model-list request.

| Provider   | Credential                      | Capability                           | Required result                                          | Device/build result |
| ---------- | ------------------------------- | ------------------------------------ | -------------------------------------------------------- | ------------------- |
| OpenAI     | API key                         | Dictation, uploads, text             | Correct transcript/text with the selected model          | Unverified          |
| Groq       | API key                         | Dictation, uploads, text             | Correct transcript/text with the selected model          | Unverified          |
| OpenRouter | API key                         | Text                                 | Discovery/manual model; inference reaches selected model | Unverified          |
| Custom     | Optional endpoint-bound API key | OpenAI-compatible transcription/text | Discovery/manual model; expected server receives request | Unverified          |

Not offered on mobile in this release: Anthropic, Gemini, xAI, Mistral, Corti, Tinfoil, Deepgram, AssemblyAI, and Live Meetings over a personal provider. Adding one is a data change (the allowlist and, for text, a chat endpoint in `src/lib/mobileProviders.ts`, plus its models in `src/config/providerCatalog.json`) only when its request shape is the OpenAI-compatible batch/chat protocol; anything else needs its own adapter and device verification.

## Automated validation

Run from `openwhispr-mobile/`: `npm test -- --runInBand`, `npm run typecheck`, `npm run lint`, `npm run format`, the production Expo export, and `python3 modules/background-uploader/tests/run-provider-transport-tests.py`. Record the counts here when they change.

## Credentials and access

- Use Bring Your Own Key while signed out and without Pro. Confirm no OpenWhispr hosted inference or allowance consumption.
- Replace/remove credentials and retry a job. Removal must reject credential reuse; it must not switch provider or model.
- Sign-out keeps personal settings/credentials. Deleting the app does not remove Keychain items; "Remove credential" and "Remove all provider keys" do, including keys for a Custom endpoint that was since changed.
- Reboot an iPhone, unlock once, lock again, and verify background credential access without a biometric prompt.
- Check valid/invalid keys, rate limits (429), quota (402), missing models (404), timeouts, cancellation, and malformed responses without exposing secrets or provider response bodies in UI/logs.
- Check organization allowlists, unresolved policy, and account changes. Provider requests must remain blocked when policy denies them.

## Privacy, keyboard, and recovery

- Start each workflow with one selection; change settings before completion/retry. The job must keep its original provider, model, endpoint, cleanup, and agent routes.
- Exercise private mode/private-note consent at each stage. No remote stage may bypass privacy because Bring Your Own Key is selected. An On-Device text selection must never reach OpenWhispr Cloud, even after the consent dialog.
- Make transcription succeed and cleanup fail. Retain raw text/audio and show the cleanup failure without calling hosted inference.
- Exercise keyboard recording, imports, explicit retry, suspension, OS termination/relaunch, and user force-quit separately.
- Start a newer keyboard job before an old native upload completes. The older completion must not overwrite current status or insert text twice.
- Force-quit during a keyboard agent command. On relaunch the spoken instruction must be neither inserted nor added to history.
- Toggle Cloud/On-Device on Home while not recording, then confirm dictation, Speech-to-Text and Bring Your Own Key screens agree; the toggle is disabled while recording.
- Record over 25 MB (or import a large file) and confirm the "25 MB provider limit" refusal happens before any upload.

## Network and native gates

- BYOK HTTP uses an ephemeral URLSession with finite UIKit background execution time, a 300 s idle timeout, and a 10 min total limit. Apple background URLSessions always follow redirects, so they are not used for direct provider credentials.
- Rebuild iOS after the native provider transport/config plugins change. A build without the native bridge must fail closed, with no JavaScript fetch fallback.
- Verify HTTP 301/302/307/308 responses never forward credentials or audio to another destination, including same-origin redirects. Keep normal TLS certificate validation enabled.
- Point a Custom server at a self-signed HTTPS endpoint. The check must say it couldn't connect securely and point at the certificate, not that the server is unreachable.
- Lock the phone during a long provider upload until iOS ends background time. The recording must stay in history as a failed item that says iOS stopped the request, and retrying it must work.
- Check public HTTPS; rejected public HTTP; LAN IP HTTP; `.local`; Tailscale IP and hostname; IPv6 loopback/link-local; unreachable hosts; and denied Local Network permission. Broad private-CIDR and `ts.net` ATS exceptions are not installed; use HTTPS where ATS blocks HTTP.

Record credential types and sanitized outcomes only. Do not attach keys, access tokens, sensitive URLs, transcript content, or raw responses.
