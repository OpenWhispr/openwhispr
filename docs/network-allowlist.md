# Network Allowlist

Outbound hosts the OpenWhispr desktop app contacts. For firewall, proxy, and
DNS filter configuration.

Destination connections are client-initiated over TLS. A configured HTTP proxy
uses an unencrypted CONNECT hop; use an HTTPS proxy when that hop also requires
TLS. No inbound ports.

## Required by default

Contacted by every install using OpenWhispr Cloud (the default after
onboarding).

| Host                                          | Protocol | Port | Purpose                                                                            |
| --------------------------------------------- | -------- | ---- | ---------------------------------------------------------------------------------- |
| `api.openwhispr.com`                          | HTTPS    | 443  | Cloud API: transcription, sync, agent reasoning, settings, usage.                  |
| `auth.openwhispr.com`                         | HTTPS    | 443  | Account sign-in and session refresh (Better Auth).                                 |
| `github.com`, `objects.githubusercontent.com` | HTTPS    | 443  | Application auto-update (release artifacts via electron-updater, GitHub provider). |

## Required for streaming transcription

OpenWhispr Cloud routes streaming sessions through one of four providers.
Allowlist all four unless a specific provider is pinned in configuration.

| Host                                | Protocol   | Port | Purpose                                                                                 |
| ----------------------------------- | ---------- | ---- | --------------------------------------------------------------------------------------- |
| `api.deepgram.com`                  | WSS        | 443  | Deepgram streaming transcription.                                                       |
| `api.openai.com`                    | WSS, HTTPS | 443  | OpenAI Realtime streaming transcription.                                                |
| `streaming.assemblyai.com`          | WSS, HTTPS | 443  | AssemblyAI streaming transcription. Token endpoint is HTTPS; live session is WSS.       |
| `generativelanguage.googleapis.com` | WSS, HTTPS | 443  | Gemini Live streaming transcription. Live session is WSS; batch transcription is HTTPS. |

## Required for local model downloads

Contacted only when a user opts into a local model (Whisper, Parakeet, or a
local GGUF reasoning model). Not required for cloud-only installs.

| Host                                                    | Protocol | Port | Purpose                                                                     |
| ------------------------------------------------------- | -------- | ---- | --------------------------------------------------------------------------- |
| `huggingface.co`                                        | HTTPS    | 443  | Whisper GGML, Parakeet, GGUF, and embedding model downloads.                |
| `cdn-lfs.huggingface.co`, `cdn-lfs-us-1.huggingface.co` | HTTPS    | 443  | HuggingFace large-file CDN (LFS-backed model files).                        |
| `github.com`, `objects.githubusercontent.com`           | HTTPS    | 443  | sherpa-onnx, llama.cpp, whisper.cpp, and Qdrant binaries (GitHub releases). |

## Required for Google Calendar (optional feature)

Contacted only if the user connects Google Calendar in settings.

| Host                    | Protocol | Port | Purpose                                                     |
| ----------------------- | -------- | ---- | ----------------------------------------------------------- |
| `accounts.google.com`   | HTTPS    | 443  | OAuth authorization.                                        |
| `oauth2.googleapis.com` | HTTPS    | 443  | OAuth token exchange and revoke.                            |
| `www.googleapis.com`    | HTTPS    | 443  | Calendar event and calendar list reads.                     |
| `openwhispr.com`        | HTTPS    | 443  | OAuth desktop callback redirect (`/auth/desktop-callback`). |

## Required for URL audio import (optional feature)

Contacted only when a user pastes a URL into the Upload view to download and
transcribe its audio. Downloads are HTTPS-only and hosts resolving to
private/internal addresses are rejected.

| Host                                                                               | Protocol | Port | Purpose                                                                      |
| ---------------------------------------------------------------------------------- | -------- | ---- | ---------------------------------------------------------------------------- |
| `www.youtube.com`, `youtube.com`, `youtu.be`, `m.youtube.com`, `music.youtube.com` | HTTPS    | 443  | YouTube page/metadata fetch for pasted YouTube links (bundled yt-dlp).       |
| `*.googlevideo.com`                                                                | HTTPS    | 443  | YouTube media CDN — the actual audio stream download.                        |
| _User-pasted hosts_                                                                | HTTPS    | 443  | Direct audio/video URL imports contact whatever public host the user pastes. |

## Required for product help lookup (optional feature)

Contacted when the assistant retrieves official help and both privacy settings
and organization policy permit online documentation lookup. The assistant must be
enabled (`agentEnabled`); the existing web-search policy (`webSearchEnabled`) also
controls documentation lookups. Signed-out and fully-local configurations use
bundled reference material without contacting this host. Only the MCP handshake and reads
of curated documentation page paths are sent; settings and conversation content are not
sent to this host. Bundled essentials remain available without this connection.

| Host                  | Protocol | Port | Purpose                                     |
| --------------------- | -------- | ---- | ------------------------------------------- |
| `docs.openwhispr.com` | HTTPS    | 443  | Public documentation search/read at `/mcp`. |

## BYOK provider hosts (only if configured)

Required only when a user configures their own API key for the corresponding
provider. Skip any provider not in use.

| Host                                                                             | Protocol   | Port | Used when                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ---------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.openai.com`                                                                 | HTTPS      | 443  | OpenAI API key configured (transcription or reasoning).                                                                                                                                                                                                                                                                                                  |
| `*.cognitiveservices.azure.com`, `*.openai.azure.com`, `*.services.ai.azure.com` | HTTPS      | 443  | Azure AI Foundry / Azure OpenAI speech-to-text configured (custom transcription provider pointed at your own Azure resource endpoint).                                                                                                                                                                                                                   |
| `api.anthropic.com`                                                              | HTTPS      | 443  | Anthropic API key configured.                                                                                                                                                                                                                                                                                                                            |
| `generativelanguage.googleapis.com`                                              | WSS, HTTPS | 443  | Gemini API key configured. Batch transcription is HTTPS; the Live streaming model opens a WSS session.                                                                                                                                                                                                                                                   |
| `api.groq.com`                                                                   | HTTPS      | 443  | Groq API key configured.                                                                                                                                                                                                                                                                                                                                 |
| `atc.tinfoil.sh`, `*.tinfoil.sh`                                                 | WSS, HTTPS | 443  | Tinfoil API key configured. `atc.tinfoil.sh` serves the enclave attestation bundle (verified locally against an embedded sigstore root). Inference and realtime transcription connect to an enclave host assigned dynamically at runtime (e.g. `inference.tinfoil.sh`, `router.infN.tinfoil.sh`), so allowlist `*.tinfoil.sh` rather than pinning hosts. |
| `api.mistral.ai`                                                                 | HTTPS      | 443  | Mistral API key configured.                                                                                                                                                                                                                                                                                                                              |
| `api.deepgram.com`                                                               | WSS, HTTPS | 443  | Deepgram API key configured. Realtime-only: dictation and note recording open a WSS session (there is no file-upload or retry path); the key check calls `/v1/auth/token` over HTTPS.                                                                                                                                                                    |
| `streaming.assemblyai.com`                                                       | WSS, HTTPS | 443  | AssemblyAI API key configured. `/v3/token` mints the short-lived session token over HTTPS; the live session is WSS. Realtime-only, like Deepgram.                                                                                                                                                                                                        |
| `api.assemblyai.com`                                                             | HTTPS      | 443  | AssemblyAI API key configured. Credential check when onboarding or Settings checks the key (`/v2/transcript`).                                                                                                                                                                                                                                           |
| `openrouter.ai`                                                                  | HTTPS      | 443  | OpenRouter selected as a reasoning provider (`/api/v1/models` is fetched even without a key; the key check calls `/api/v1/key`).                                                                                                                                                                                                                         |

## Organization-managed audio (only if configured)

Allow the exact customer origins and explicit ports configured for each operation.
Private gateway DNS/VPN access is required on the desktop. A hosted server's
reachability check does not establish access from a device, and required enterprise
routing does not fall back to public OpenAI hosts.

| Host                                                                             | Protocol                      | Port                          | Purpose                                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| _Configured customer batch endpoint_                                             | HTTPS                         | Configured port, normally 443 | Direct audio uploads, chunks and history retries. Custom paths and non-secret queries are retained.        |
| _Configured customer realtime endpoint_                                          | WSS                           | Configured port, normally 443 | Live mic and system-audio transcription, including separate sessions and reconnects.                       |
| `*.openai.azure.com`, `*.cognitiveservices.azure.com`, `*.services.ai.azure.com` | HTTPS, WSS                    | 443                           | Direct Azure resource operations when that resource is configured.                                         |
| `login.microsoftonline.com`                                                      | HTTPS                         | 443                           | Direct managed Azure Entra token exchange; not used by a generic device-key gateway profile.               |
| `api.openwhispr.com` (or the configured API origin)                              | HTTPS                         | 443                           | Workspace policy/configuration, public CA artifacts, device-check results and Azure federation assertions. |
| `auth.openwhispr.com` (or the configured auth origin)                            | HTTPS                         | 443                           | Sign-in and session refresh.                                                                               |
| _Configured or system/PAC-selected proxy hosts_                                  | HTTP CONNECT or HTTPS CONNECT | Configured proxy ports        | Enterprise Node HTTP/WSS tunnel setup; Basic credentials use a separate device-local slot.                 |

Enterprise HTTP and WebSocket traffic uses Node TLS and per-connection agents;
Electron resolves system/PAC proxy choices. Node explicitly loads available
system/default roots and the selected workspace PEM bundle. Proxy and destination
TLS validation both remain enabled. A mandatory proxy excludes `DIRECT` and does
not become a direct connection after resolution/CONNECT failure. Basic is supported;
SOCKS and NTLM/Kerberos/Negotiate are not supported by this implementation.

Policy/configuration, authentication and setup-report calls keep the existing
Electron network path. Install OS corporate roots first when that control-plane
traffic is intercepted: an application CA artifact cannot bootstrap the connection
needed to download itself. A device bootstrap is a protected local file, not a
network credential-delivery endpoint. See the
[enterprise audio runbook](enterprise-audio-runbook.md) for exact file format,
device paths, permissions, rotation and required-mode rollout.

Audio routing does not determine transcript/note sync, formatting/chat or backup
destinations. Verify their separate provider, retention and backup policies before
describing the deployment's data boundary.

## Notes

- Most control-plane requests use Electron's network stack, which honors system proxy settings
  (macOS System Settings, Windows Internet Options / WPAD, GNOME proxy) and
  PAC scripts on all platforms. Enterprise audio has the scoped Node transport
  described above; other Node/provider paths must be checked separately.
- Connections fail with `ENOTFOUND` if DNS is filtered, `ECONNREFUSED` /
  `ETIMEDOUT` if a firewall blocks the host, and `CERT_HAS_EXPIRED` /
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` if a TLS-intercepting proxy is in the
  path without its root certificate trusted by the OS.
- IP-pinning is not supported. The hosts above resolve to provider-managed
  IPs that change without notice.
- On minimal Linux containers without a system CA bundle (Alpine, distroless),
  set `NODE_EXTRA_CA_CERTS` to your CA bundle path so corporate TLS interception
  is trusted.

## How to test

Run from a machine on the same network as the user. A successful response
(any HTTP status, including `401`) confirms the network path works.
For enterprise audio, use **Enterprise audio setup** on the actual desktop to test
both file transcription and the realtime session handshake with its selected
credentials, CA and proxy profile. A curl HTTP response alone does not prove WSS,
session messages, capture, recognition or fleet readiness.

```sh
# OpenWhispr Cloud reachability
curl -v https://api.openwhispr.com/api/health

# Streaming providers
curl -v https://api.deepgram.com/v1/projects
curl -v https://api.openai.com/v1/models
curl -v https://streaming.assemblyai.com/v3/token
curl -v https://generativelanguage.googleapis.com/v1beta/models

# Model downloads (only if local mode is in use)
curl -v -I https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
```

If a request returns `Could not resolve host`, the DNS layer (resolver,
filter, or ad blocker) is blocking the domain. If it hangs or returns
`Connection refused`, a firewall is blocking the port. If it returns a TLS
error, a proxy is intercepting the connection without a trusted root.
