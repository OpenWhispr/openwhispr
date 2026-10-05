# Custom ASR shim for OpenWhispr

OpenWhispr's Self-Hosted transcription mode assumes the OpenAI wire format: it POSTs `multipart/form-data` to `{Server URL}/audio/transcriptions` and reads back JSON `{"text": "..."}`. Plenty of ASR APIs do not speak that format. StepFun StepAudio 2.5, Alibaba, Baidu, Tencent, and various enterprise speech platforms each have their own request shape, audio encoding, and response envelope. Point OpenWhispr straight at one of them and the call fails with a 400/501-type error because the bytes on the wire do not line up. A small shim that runs on your machine bridges the two: OpenWhispr keeps speaking OpenAI, the shim translates to and from your vendor, and you change nothing inside OpenWhispr.

## How it works

```
OpenWhispr  --multipart audio-->  shim (localhost:8765)  --vendor format-->  ASR API
OpenWhispr  <--{"text": "..."}--  shim                   <--vendor reply--   ASR API
```

The shim listens on `/audio/transcriptions` (and `/v1/audio/transcriptions`), transcodes the recording with ffmpeg into whatever the vendor needs, calls the vendor, and returns the OpenAI-shaped JSON OpenWhispr expects.

## What OpenWhispr sends and expects

Request: `POST {Server URL}/audio/transcriptions`, `multipart/form-data`.

| Field | Required | Notes |
|-------|----------|-------|
| `file` | yes | The recording. Default is WebM/Opus, filename `audio.webm`. May also be ogg/mp4/mp3/wav. Transcode it before sending to the vendor. |
| `model` | no | The Model string from the Self-Hosted panel, when set. Tolerate empty or missing. |
| `language` | no | Present only when you pick a non-auto language (ISO code like `en`). |
| `prompt` | no | A custom-dictionary hint string. |

`Authorization: Bearer <key>` is not part of the Self-Hosted panel. Do not require it from OpenWhispr's side. Hold your vendor API key in an environment variable inside the shim (see `STEP_API_KEY` below).

Self-Hosted transcription is batch HTTP only. OpenWhispr does not send `stream=true` on this path, so the shim returns a single JSON object, not SSE, even if the upstream vendor streams.

Response: HTTP 200 with JSON `{"text": "..."}`. OpenWhispr reads the `.text` field. Empty or missing text shows "No audio detected" to the user. A non-200 status is surfaced as an API error.

## HTTP vs HTTPS

OpenWhispr requires HTTPS for custom endpoints but exempts private and loopback hosts. A shim on `http://localhost:8765` works over plain HTTP. A shim reachable on a public host must use HTTPS (put it behind a TLS reverse proxy, or terminate TLS in the shim).

Plain `http://` is allowed for these hosts:

- `localhost` and any `*.local` hostname
- `127.0.0.0/8` (loopback) and IPv6 `::1`
- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (private ranges)
- `169.254.0.0/16` (link-local) and IPv6 `fe80::/10`
- `100.64.0.0/10` (CGNAT)
- IPv6 `fc00::/7` (unique local)

## Prerequisites

- Python 3.8 or newer (standard library only, no pip installs)
- ffmpeg on your PATH

## Quick start

Generic template, after you fill in the `transcribe()` function:

```sh
python3 shim_template.py
```

StepAudio 2.5:

```sh
export STEP_API_KEY=sk-...
python3 stepaudio_shim.py
```

On Windows PowerShell:

```powershell
$env:STEP_API_KEY = "sk-..."
python stepaudio_shim.py
```

The StepAudio shim transcribes Chinese by default (`language: zh`) and ignores the language OpenWhispr forwards. Change the `language` value in `stepaudio_shim.py` for other languages.

Then in OpenWhispr:

1. Open **Settings → Transcription**
2. Choose **Self-Hosted**
3. Set **Server URL** to `http://localhost:8765`
4. Optionally set **Model** (passed through as the `model` field; the StepAudio shim ignores it)

The StepAudio shim reads `STEP_API_KEY` from the environment, not from OpenWhispr.

## Adapt it to another vendor

Copy `shim_template.py` and replace the single `transcribe()` function with your vendor's call. Everything else (the HTTP server, the multipart parser, the ffmpeg transcode, the size guard, temp-file cleanup, the response shape) already matches what OpenWhispr expects, so you only touch the one function that talks to your backend. `stepaudio_shim.py` is a worked example of exactly that.

## Tests

`test_shim.py` covers the multipart parser, the StepAudio SSE parser, and the HTTP endpoints (with ffmpeg and the vendor call stubbed out). Standard library only:

```sh
python3 test_shim.py
```

## Credit

Thanks to [@ErogosZhou](https://github.com/ErogosZhou) for the original StepAudio shim that this example is built on: https://gist.github.com/ErogosZhou/4eb2c4bab1059b404fb652df7bfe24ac

Addresses issue #972.
