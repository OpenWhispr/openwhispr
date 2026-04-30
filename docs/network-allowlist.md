# Network Allowlist

Outbound hosts the OpenWhispr desktop app contacts. For firewall, proxy, and
DNS filter configuration.

All connections are client-initiated over TLS. No inbound ports.

## Required by default

Contacted by every install using OpenWhispr Cloud (the default after
onboarding).

| Host | Protocol | Port | Purpose |
| --- | --- | --- | --- |
| `api.openwhispr.com` | HTTPS | 443 | Cloud API: transcription, sync, agent reasoning, settings, usage. |
| `*.neonauth.c-3.us-east-1.aws.neon.tech` | HTTPS | 443 | Account sign-in and session refresh (Neon Auth). |
| `github.com`, `objects.githubusercontent.com` | HTTPS | 443 | Application auto-update (release artifacts via electron-updater, GitHub provider). |

## Required for streaming transcription

OpenWhispr Cloud routes streaming sessions through one of three providers.
Allowlist all three unless a specific provider is pinned in configuration.

| Host | Protocol | Port | Purpose |
| --- | --- | --- | --- |
| `api.deepgram.com` | WSS | 443 | Deepgram streaming transcription. |
| `api.openai.com` | WSS, HTTPS | 443 | OpenAI Realtime streaming transcription. |
| `streaming.assemblyai.com` | WSS, HTTPS | 443 | AssemblyAI streaming transcription. Token endpoint is HTTPS; live session is WSS. |

## Required for local model downloads

Contacted only when a user opts into a local model (Whisper, Parakeet, or a
local GGUF reasoning model). Not required for cloud-only installs.

| Host | Protocol | Port | Purpose |
| --- | --- | --- | --- |
| `huggingface.co` | HTTPS | 443 | Whisper GGML, Parakeet, GGUF, and embedding model downloads. |
| `cdn-lfs.huggingface.co`, `cdn-lfs-us-1.huggingface.co` | HTTPS | 443 | HuggingFace large-file CDN (LFS-backed model files). |
| `github.com`, `objects.githubusercontent.com` | HTTPS | 443 | sherpa-onnx, llama.cpp, whisper.cpp, and Qdrant binaries (GitHub releases). |

## Required for Google Calendar (optional feature)

Contacted only if the user connects Google Calendar in settings.

| Host | Protocol | Port | Purpose |
| --- | --- | --- | --- |
| `accounts.google.com` | HTTPS | 443 | OAuth authorization. |
| `oauth2.googleapis.com` | HTTPS | 443 | OAuth token exchange and revoke. |
| `www.googleapis.com` | HTTPS | 443 | Calendar event and calendar list reads. |
| `openwhispr.com` | HTTPS | 443 | OAuth desktop callback redirect (`/auth/desktop-callback`). |

## BYOK provider hosts (only if configured)

Required only when a user configures their own API key for the corresponding
provider. Skip any provider not in use.

| Host | Protocol | Port | Used when |
| --- | --- | --- | --- |
| `api.openai.com` | HTTPS | 443 | OpenAI API key configured (transcription or reasoning). |
| `api.anthropic.com` | HTTPS | 443 | Anthropic API key configured. |
| `generativelanguage.googleapis.com` | HTTPS | 443 | Gemini API key configured. |
| `api.groq.com` | HTTPS | 443 | Groq API key configured. |
| `api.mistral.ai` | HTTPS | 443 | Mistral API key configured. |

## Notes

- The app uses Electron's network stack, which honors system proxy settings
  (macOS System Settings, Windows Internet Options / WPAD, GNOME proxy) and
  PAC scripts on all platforms.
- Connections fail with `ENOTFOUND` if DNS is filtered, `ECONNREFUSED` /
  `ETIMEDOUT` if a firewall blocks the host, and `CERT_HAS_EXPIRED` /
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` if a TLS-intercepting proxy is in the
  path without its root certificate trusted by the OS.
- IP-pinning is not supported. The hosts above resolve to provider-managed
  IPs that change without notice.

## How to test

Run from a machine on the same network as the user. A successful response
(any HTTP status, including `401`) confirms the network path works.

```sh
# OpenWhispr Cloud reachability
curl -v https://api.openwhispr.com/api/health

# Streaming providers
curl -v https://api.deepgram.com/v1/projects
curl -v https://api.openai.com/v1/models
curl -v https://streaming.assemblyai.com/v3/token

# Model downloads (only if local mode is in use)
curl -v -I https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
```

If a request returns `Could not resolve host`, the DNS layer (resolver,
filter, or ad blocker) is blocking the domain. If it hangs or returns
`Connection refused`, a firewall is blocking the port. If it returns a TLS
error, a proxy is intercepting the connection without a trusted root.
