# Personal BYOK release checks

The shared catalog describes target capabilities, not a credentialed certification. All real-provider and physical-device results below are **unverified** until a maintainer records the device, OS, build commit, date, and sanitized result. Do not release full provider parity based only on mocked tests or a successful model-list request.

| Provider   | Credential                      | Target capability                              | Required result                                                               | Device/build result                                  |
| ---------- | ------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| OpenAI     | API key                         | Dictation, uploads, live meetings, text        | Correct transcript/text; partial/final meeting events                         | Unverified                                           |
| Groq       | API key                         | Dictation, uploads, text                       | Correct transcript/text with selected model                                   | Unverified                                           |
| xAI        | API key                         | Dictation, uploads                             | Correct provider-specific transcription                                       | Unverified                                           |
| Mistral    | API key                         | Dictation, uploads                             | Correct Voxtral request and transcript                                        | Unverified                                           |
| Gemini     | API key                         | Dictation, uploads, text; Live dictation only  | Batch and Live model restrictions respected                                   | Unverified                                           |
| Anthropic  | API key                         | Text                                           | Correct system/user messages and returned text                                | Unverified                                           |
| OpenRouter | API key                         | Text                                           | Discovery/manual model; inference reaches selected model                      | Unverified                                           |
| Corti      | Client ID and client secret     | Dictation, uploads, live meetings, text        | Correct token scopes, refresh, audio/text protocol                            | Unverified                                           |
| Tinfoil    | API key                         | Dictation, uploads, live meetings, text        | Verified HTTP and attestation-pinned WebSocket; tampering blocks transmission | Unverified on device; attested transport implemented |
| Deepgram   | API key                         | Streaming dictation and live meetings          | Partial/final transcript and timestamps; uploads excluded                     | Unverified                                           |
| AssemblyAI | API key                         | Streaming dictation and live meetings          | Partial/final transcript and timestamps; uploads excluded                     | Unverified                                           |
| Custom     | Optional endpoint-bound API key | OpenAI-compatible batch transcription and text | Discovery/manual model; expected server receives request                      | Unverified                                           |

## Automated validation

On 2026-09-21, all 1,779 mobile tests (183 suites) and 4,720 desktop tests passed. Desktop validation used bounded test concurrency; 12 tests were skipped and one remains a pre-existing TODO. Both apps passed formatting, lint (warnings remain), and TypeScript checks. The iOS production Expo export passed, the EAS inspection archive included all five shared AI source/catalog files, and Expo Doctor passed 20/20 checks. The native Foundation transport harness verifies JSON and file-upload redirect refusal against two local servers, cancellation before and after task registration, error-body redaction, endpoint restrictions, and secret-free route serialization. UI tests cover signed-out setup, credential references, endpoint validation, and selection changes. Recovery tests cover all pending jobs, original stage routes, durable save failure, and cancellation. An ASAR smoke with the production desktop packaging filter and Electron runtime verified the moved shared catalog and main-process imports; no release installer was produced.

These checks do not certify provider access, attestation on a physical device, Keychain accessibility, keyboard recovery, or LAN permissions. The native Xcode build also passed for arm64 and x86_64 simulator architectures with signing disabled and `IPHONEOS_DEPLOYMENT_TARGET=17.0`. The installed CoreSimulator runtime is incompatible with this Xcode version, so the app was compiled but not launched in a simulator. Physical-device results remain open.

## Credentials and access

- Use Providers while signed out and without Pro. Confirm no OpenWhispr hosted inference or allowance consumption.
- Replace/remove credentials and retry a job. Removal must reject credential reuse; it must not switch provider or model.
- Verify sign-out keeps personal settings/credentials; full app-data reset removes credentials, including after a previous interrupted reset.
- Reboot an iPhone, unlock once, lock again, and verify background credential access. Keys must not migrate to another device or require interactive biometrics per request.
- Check valid/invalid keys, rate limits, quota, missing models, timeout, cancellation, and malformed responses without exposing secrets or provider response bodies in UI/logs.
- Check organization allowlists, unresolved policy, and account changes. Provider requests must remain blocked when policy denies them.

## Privacy, keyboard, and recovery

- Start each workflow with one selection; change settings before completion/retry. The job must keep its original provider, model, endpoint, cleanup, and agent routes.
- Exercise private mode/private-note consent at each stage. No remote stage may bypass privacy because Providers is selected.
- Make transcription succeed and cleanup fail. Retain raw text/audio and show the cleanup failure without calling hosted inference.
- Exercise keyboard recording, imports, explicit retry, suspension, OS termination/relaunch, and user force-quit separately. Force-quit is a recovery test, not a promise of continued execution.
- Start a newer keyboard job before an old native upload completes. The older completion must not overwrite current status or insert text twice.
- Verify recovered native jobs use their per-job route snapshot, never the latest global settings. Agent commands must not be inserted as raw text when agent processing is incomplete.
- Run meeting reconnect/cancellation and verify speaker/timestamp continuity for each supported transport.

## Network and native gates

- BYOK HTTP uses an ephemeral URLSession with finite UIKit background execution time. Apple background URLSessions always follow redirects, so they are not used for direct provider credentials. If suspension/termination interrupts a transfer, retry retained audio using the original route. Do not promise out-of-process BYOK completion. See [Apple background transfer limitations](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background).
- Rebuild iOS after the native provider transport/config plugins change. A build without the native bridge must fail closed, with no JavaScript fetch fallback.
- Verify HTTP 301/302/307/308 responses never forward credentials or audio to another destination, including same-origin redirects. Keep normal TLS certificate validation enabled.
- Check public HTTPS; rejected public HTTP; LAN IP HTTP; `.local`; Tailscale IP and hostname; IPv6 loopback/link-local; unreachable hosts; and denied Local Network permission.
- Current configuration declares `NSLocalNetworkUsageDescription` and `NSAllowsLocalNetworking`. Broad private-CIDR and `ts.net` ATS exceptions were not approved and are not installed. LAN IP/Tailscale HTTP behavior on iOS 17+ remains a device gate; use HTTPS where ATS blocks HTTP. See [Apple's local-network ATS documentation](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking).
- Verify Expo export and an EAS archive include shared TypeScript/JSON. Compile the native app and test actual Keychain, keyboard App Group, and background URLSession behavior.
- Tinfoil HTTP and WebSocket attested transports are implemented with a pinned SDK revision. Verify both paths on-device; expired/invalid evidence and certificate mismatch must prevent transmission. Ordinary HTTPS is not a fallback.

Record credential types and sanitized outcomes only. Do not attach keys, access tokens, sensitive URLs, transcript content, or raw responses. Keep each unverified item open until its exact device/provider path has been exercised.
