# Enterprise audio deployment and recovery

Organization-managed file transcription and live meetings use either direct Azure
OpenAI with Entra federation or an explicit `openai-compatible` HTTPS/WSS profile.
One provider owns the transcription scope, with separate batch and realtime
operations. Text inference can have a different owner. A required provider without
the requested audio operation blocks that operation; it does not select a public
provider. Meeting recording and file upload remain independently controlled by
workspace feature policy.

## Stage and provision a device

1. Deploy the additive API contract and migrations, then the supporting desktop,
   then the admin console. See the [release dependencies](#release-dependencies).
2. Save the audio provider in **disabled** mode. Configure full batch HTTPS and
   realtime WSS URLs, deployment aliases, authentication slots, protocol and network
   settings. Gateways retain custom prefixes, ports and non-secret query parameters.
   Never place credentials in the provider JSON, URL, CA bundle or deep link.
3. Install corporate roots in the device trust store before sign-in/configuration
   access if the network intercepts OpenWhispr control-plane traffic. Workspace PEM
   bundles arrive through that control plane, so they cannot bootstrap trust for it.
4. Upload additional public PEM roots through the admin console when needed for
   the audio endpoint, its proxy or the Azure token exchange. Compare the displayed
   certificate subjects, expiry and SHA-256 fingerprints with IT's approved values.
   Private keys and fetched CA URLs are not provisioning inputs.
5. Sign in on the desktop and select the intended workspace. Open transcription
   or meeting settings, then **Enterprise audio setup**. Provision each named slot
   manually or import a protected bootstrap file. The UI displays presence, not
   saved key values. An audio slot contains the literal Bearer/API key; a proxy slot
   contains the JSON string `{"username":"user","password":"password"}`.
6. Acknowledge the short, potentially billable inference probes and test both
   configured operations. A batch test uploads a short silent WAV and checks a JSON
   text response. A realtime test checks the configured session handshake and sends
   silence. These tests establish operation acceptance, not recognition quality or
   native system-audio capture. Results are tied to this configuration and device;
   editing the profile makes them stale.
7. Pilot actual uploads, history retries and two-channel meetings on the target
   corporate network before enabling required mode. Disabled draft tests require
   workspace-admin authorization. The console's desktop-test link contains only
   workspace/provider references; the desktop checks the signed-in workspace again.

### Protected MDM bootstrap

Deliver `enterprise-audio-bootstrap.json` directly inside the active desktop's
`userData` directory. The diagnostic `userDataPath` value is authoritative; do not
deliver to the application installation directory. Common production paths are:

| OS      | `userData` directory                        |
| ------- | ------------------------------------------- |
| macOS   | `~/Library/Application Support/open-whispr` |
| Windows | `%APPDATA%\open-whispr`                     |
| Linux   | `${XDG_CONFIG_HOME:-~/.config}/open-whispr` |

Staging and development use `OpenWhispr-staging` and `OpenWhispr-development`
under the OS application-data directory. Confirm the running channel's diagnostic
path before delivery.

```json
{
  "version": 1,
  "accountId": "signed-in-account-id",
  "workspaceId": "workspace-uuid",
  "credentials": {
    "audio-http": "device-audio-key",
    "audio-realtime": "device-realtime-key",
    "corporate-proxy": "{\"username\":\"user\",\"password\":\"password\"}"
  }
}
```

Replace the example slots with exactly those configured for this provider's batch,
realtime and proxy authentication. Omit unused slots; one slot can be shared when
both operations use the same credential. The account and workspace must match the
signed-in desktop, and every delivered slot must be configured for that provider.
The import accepts at most 20 non-empty, single-line values of at most 16,384
characters each, within a regular file no larger than 512 KiB.

On macOS/Linux, deliver an owner-only file (`0600`), owned by the target user or
root, in a directory the app can read and rename. Symlinks and group/other access
are rejected. A root-owned file must still be readable by the desktop; per-user
MDM delivery is usually simpler. On Windows, restrict the file ACL to the intended
user and required administrators/SYSTEM; remove read grants to Everyone,
Authenticated Users and Users. The importer checks those broad principals using
PowerShell; this is not an ACL repair operation.

Publish the file atomically from a protected temporary file, then click **Import
organization bootstrap**. Import is user initiated, not an unattended startup
watcher. Main claims the file by renaming it to a unique `.importing` name, checks
its binding, encrypts credentials into `userData/enterprise-audio-keys/*.enc`, then
removes the plaintext. A rejected import preserves the file for correction without
overwriting a newer MDM delivery. Inspect for stranded `.importing` files after an
interrupted import and remove obsolete plaintext through the device-management
system. Never collect bootstrap contents in support logs. Encryption reuses the
desktop OS keychain/safe-storage backend; a missing backend is a provisioning
failure. App-data reset removes enterprise keys and the bootstrap file.

### Azure API-key authentication

The direct `azure` managed record uses Entra federation. To use an Azure API key,
create an explicit `openai-compatible` audio profile with `authentication.type`
set to `api-key`, a device credential slot and complete Azure operation URLs. The
provider is chosen explicitly; an Azure-looking hostname does not select an auth
scheme. For example, a profile's operation sections can be:

```json
{
  "batch": {
    "endpoint": "https://example.openai.azure.com/openai/deployments/speech-batch/audio/transcriptions?api-version=2025-03-01-preview",
    "allowedDeployments": ["speech-batch"],
    "defaultDeployment": "speech-batch",
    "authentication": { "type": "api-key", "credentialSlot": "azure-audio-key" }
  },
  "realtime": {
    "endpoint": "wss://example.openai.azure.com/openai/v1/realtime?intent=transcription",
    "allowedDeployments": ["speech-live"],
    "defaultDeployment": "speech-live",
    "authentication": { "type": "api-key", "credentialSlot": "azure-audio-key" },
    "protocol": "openai-transcription-ga",
    "sampleRate": 24000
  }
}
```

These are example aliases, not evidence that a deployment supports either API.
Choose the actual resource, batch API version, realtime surface and accepted
deployment names. Preview realtime uses the explicit preview protocol and URL;
do not mix preview messages with a GA endpoint. This profile does not mint a
public OpenAI ephemeral token or an Entra assertion. Real Azure acceptance remains
required for the chosen resource and operation combination.

## Trust, proxies and operational limits

Enterprise HTTP and `ws` sockets use Node TLS with packaged/default plus available
system roots, and any selected workspace bundle. Electron resolves system/PAC
proxy candidates for both operations; Node performs the connection. Fixed
HTTP/HTTPS proxies use CONNECT. Both proxy TLS and destination TLS must validate.
Additional roots are scoped to the enterprise transport; unrelated providers and
their transports retain their current trust/proxy handling. OpenWhispr
control-plane requests retain their existing Electron network path.

Supported proxy modes are `system` (default), `fixed` and `direct`. Fixed profiles
can use hostname/wildcard/`<local>` bypass entries. A mandatory proxy ignores
bypasses and excludes PAC `DIRECT` candidates; lookup or connection failure cannot
silently dial directly. New connections re-resolve system/PAC settings. Explicit
Basic proxy authentication is supported through a separate device slot.
SOCKS and NTLM/Kerberos/Negotiate are unsupported in this implementation; a scheme
needed by a customer must be proved in the packaged runtime before rollout.

| Limit                      | Current behavior                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP/connect budget        | Defaults: 600 seconds for the request, 15 seconds for connection setup. Configurable HTTP budget: 1–600 seconds; connect budget: 1–120 seconds.                                                                                                        |
| Realtime liveness/lifetime | Optional idle budget: 10–600 seconds; configured session lifetime: 1–60 minutes. Default proactive renewal is 55 minutes. A request timeout is not a session lifetime.                                                                                 |
| Upload size                | Azure: 25 MiB file cap per request. Generic profile: configured `maxUploadBytes`, default 25 MiB, desktop ceiling 100 MiB. Configure a lower cap when the gateway/provider requires one.                                                               |
| Long files                 | Preparation precedes chunking; oversized inputs become ordered 128-kbit/s mono MP3 segments at 16 kHz, at most 10 minutes each and bounded by encoded size. One chunk is in flight.                                                                    |
| Retry/partial output       | Rate limits and server errors get at most three attempts per chunk with bounded backoff. Exhausted chunks can leave a usable but explicitly incomplete transcript. Authentication, profile/credential changes and cancellation stop the remaining job. |
| Realtime audio             | PCM16 mono, 24 kHz, explicit GA or preview transcription dialect. Mic and system audio require separate concurrent sessions.                                                                                                                           |
| Results                    | Batch uses JSON text. No native timestamp/speaker capability is advertised; optional local speaker processing keeps the original timeline and can report a warning.                                                                                    |
| Response bounds            | HTTP responses and individual incoming WebSocket messages are bounded to 8 MiB.                                                                                                                                                                        |

Cancellation covers preparation, queued chunks, backoff, authentication waits and
in-flight transport. A job retains its original profile lifetime and credential
generation; it does not adopt a rotated key between chunks. A fresh job or
replacement meeting socket resolves the current profile. Credential/profile/CA,
workspace and sign-in changes retire enterprise connections and stop active
enterprise recording. Required activation also stops an existing personal meeting.

### Rotation and recovery

1. For key rotation, stage the new device credential and replace the configured
   slot value on each device. Saving/importing it retires that device's current
   enterprise connections and upload jobs. Start a new job and retest both
   operations before broad enforcement. Removing a slot leaves that device blocked
   until it is provisioned again.
2. For CA rotation, deploy a temporary approved bundle covering the transition,
   save the profile referencing it, and retest HTTP/WSS plus Azure token exchange
   where used. Remove the old root only after fleet migration. System roots are
   cached lazily by the Node transport; restart the app after OS trust-store changes.
3. For proxy/VPN/private-DNS changes, test from the affected device and network.
   Preserve proxy requirements; never fix a rollout by disabling TLS verification.
4. If a profile is broken, disable it or select a previously accepted profile in
   the admin console and check resulting workspace policy. Enterprise-only policy
   can still block personal routes. Disable new records before rolling back a
   backend to a version that cannot parse them.

Setup returns bounded diagnostic codes such as `CREDENTIAL_MISSING`, `TLS_FAILED`,
`PROXY_FAILED`, `AUTH_REJECTED`, `TIMEOUT`, `CONFIG_CHANGED` or `PROTOCOL_FAILED`.
Check credential presence, exact account/workspace/profile binding, CA fingerprints,
VPN/DNS, proxy mode and Basic credentials, then deployment/protocol compatibility.
Collect app/OS version, operation, configuration fingerprint and sanitized errors;
do not include API keys, proxy passwords or bootstrap contents. See the
[network allowlist](network-allowlist.md) for separate endpoint requirements.

## Data destinations and rollout

Audio inference goes to the configured customer endpoint. Azure federation also
contacts OpenWhispr's assertion API and Microsoft Entra; gateway credentials remain
device-local. Transcript/note sync and backup use their existing OpenWhispr
destinations and policy. Formatting/chat use their own selected provider. Local
history/audio retention remains separately governed. An Azure STT setting alone
does not keep transcripts, summaries or backups inside Azure. Verify all four
destinations and the effective backup/retention policy during acceptance.

Pilot a disabled/default profile with provisioned devices first. Before required
activation, acknowledge that private endpoints cannot be reached by a hosted probe
and that unprovisioned devices will block. Set the actual released minimum desktop
version: this branch targets **1.12.0**; the package version alone does not prove a
distributed build contains it. Exercise all four meeting/upload feature-policy
combinations and verify dictation remains independent. Do not equate a server
Azure probe or one device's successful test with fleet readiness.

### Validation and current evidence

Run from the desktop checkout with Node 24+, installed dependencies, OpenSSL and
FFmpeg available. Missing OpenSSL skips real TLS tests and is not a transport pass.

```sh
node --import tsx --test "test/helpers/enterpriseAudio*.test.js" test/helpers/managedAudioFileTranscription.test.js test/helpers/managedTranscriptionExecutor.test.js test/stores/meetingRecordingStoreImports.test.js
npm run lint
npm run typecheck
npm run i18n:check
```

For release qualification, also run the complete repository CI checks with native
dependencies built for the testing runtime, including `REQUIRE_DB_TESTS=1 npm test`
(PowerShell: set `$env:REQUIRE_DB_TESTS="1"` before `npm test`). Then use the actual
packaged app on macOS, Windows and Linux for HTTP/WSS, capture, reconnect,
stop-flush/persistence, revocation and customer proxy/trust tests.

Recorded development evidence on macOS with Electron 41.10.7 includes an actual
Whisper-backed upload with SQLite persistence; two GA socket handshakes; fake-mic
recording with stop/flush/persistence; a 126-second, three-chunk job; and an hour-long
approximately 115 MB source across 60 chunks. Those routes used local HTTPS/WSS
fixtures, an additional CA and a mandatory Basic-authenticated HTTPS CONNECT proxy
with exact custom paths. Native system-audio capture was excluded.

Focused enterprise transport and encrypted-credential/bootstrap tests passed on
the actual Electron binaries in `ELECTRON_RUN_AS_NODE` mode:

| OS                 | Runtime                                             | Result                               |
| ------------------ | --------------------------------------------------- | ------------------------------------ |
| macOS              | Packaged Electron 41.10.7                           | 11/11 passed, zero skipped or failed |
| Windows 11         | Installed OpenWhispr Electron 41.10.5, Node 24.18.0 | 11/11 passed, zero skipped or failed |
| Linux arm64 Docker | Electron 41.10.7 binary                             | 11/11 passed, zero skipped or failed |

The same 11 tests also passed without skips under Windows Node 24.19 with OpenSSL
3.5.9 and a Linux Node 24 Docker container. Windows exercised the actual Windows
bootstrap permission path. These runtime tests do not exercise GUI/native audio
capture, NTLM/Kerberos/Negotiate or real Azure/customer networks. Acceptance for
those paths remains separate from the confirmed HTTP/WSS and credential-store
results.

### Release dependencies

Connectivity API: [API #329](https://github.com/OpenWhispr/openwhispr-api/pull/329).
Admin: [admin #28](https://github.com/OpenWhispr/openwhispr-admin/pull/28). Their
desktop counterpart must be released before required activation. Independent
feature controls are [API #324](https://github.com/OpenWhispr/openwhispr-api/pull/324),
[desktop #2874](https://github.com/OpenWhispr/openwhispr/pull/2874) and
[admin #27](https://github.com/OpenWhispr/openwhispr-admin/pull/27); deploy API,
desktop, then admin controls.

Existing work was incorporated from [API #267](https://github.com/OpenWhispr/openwhispr-api/pull/267)
and [admin #26](https://github.com/OpenWhispr/openwhispr-admin/pull/26) for bounded,
configuration-bound Azure probes/consent, and
[desktop #2839](https://github.com/OpenWhispr/openwhispr/pull/2839) for shared identity
request/body deadlines, already present in the desktop base. The older
[desktop #1009](https://github.com/OpenWhispr/openwhispr/pull/1009) informed Azure
endpoint/API-key review only; its historical BYOK branch was not copied wholesale.
These references are implementation provenance, not acceptance evidence.
