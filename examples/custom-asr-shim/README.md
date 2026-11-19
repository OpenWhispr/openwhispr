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

| Field      | Required | Notes                                                                                                                               |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `file`     | yes      | The recording. Default is WebM/Opus, filename `audio.webm`. May also be ogg/mp4/mp3/wav. Transcode it before sending to the vendor. |
| `model`    | no       | The Model string from the Self-Hosted panel, when set. Tolerate empty or missing.                                                   |
| `language` | no       | Present only when you pick a non-auto language (ISO code like `en`).                                                                |
| `prompt`   | no       | A custom-dictionary hint string.                                                                                                    |

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

The optional [Bark 3.0 Clean adapter](#local-bark-30-clean) also needs Python 3.12
and its separate model/runtime dependencies. The generic and StepAudio shims
remain standard-library only.

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

## Local Bark 3.0 Clean

`bark_shim.py` runs [Underdog Bark 3.0 Clean](https://huggingface.co/ConwayResearch/Underdog-Bark-3.0-Clean)
on the CPU and serves it through the same Self-Hosted HTTP contract. Bark Clean
removes fillers and false starts itself. It is English only and does not support
custom dictionary prompts. This is a local model adapter, separate from the
Underdog desktop app and from OpenWhispr's bundled sherpa-onnx models.

From this directory, create an isolated environment and install the CPU runtime:

```sh
python3.12 -m venv .venv-bark
. .venv-bark/bin/activate
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r requirements-bark.txt
```

Download the published weights and Python loader. The adapter executes that local
loader, so review it before running. `NOTICE` contains the model's CC-BY-4.0
attribution; keep it with the model. This example pins the revision tested here:

```sh
hf download ConwayResearch/Underdog-Bark-3.0-Clean \
  --revision 6d34ed8639b2b9a33e764acf06748519bbb950cf \
  --include model.bark bark_loader.py NOTICE README.md \
  --local-dir "$HOME/.local/share/openwhispr-bark-clean/model"

python bark_shim.py \
  --model-dir "$HOME/.local/share/openwhispr-bark-clean/model"
```

The first start unpacks the roughly 180 MB download and fetches NVIDIA's public
processor/generation configuration. It caches the unpacked model and processor in
`MODEL_DIR/.openwhispr-cache` (about 2.5 GB on disk). Subsequent starts reuse that
cache; its key includes the weight and loader contents. To run without network
access after the first successful start, set `HF_HUB_OFFLINE=1`.

Wait for the `Ready` message, then open **Settings → Speech-to-Text → Dictation**:

1. Choose **Self-Hosted**.
2. Set **Server URL** to `http://127.0.0.1:8765`.
3. Set **Model** to `underdog-bark-3.0-clean` (or leave it empty).
4. Under **Language Models → Dictation Cleanup**, turn off **Enable text cleanup**
   if you want Bark Clean's output without a separate model pass.

The server binds to loopback only and sends no audio to a cloud provider. It keeps
one model loaded, serializes inference, and splits long audio at quiet points near
30-second boundaries to bound attention memory. The shared HTTP adapter rejects
uploads over 25 MiB, and Bark rejects audio over ten minutes. Chunk boundaries can
affect transcription accuracy; short dictation is the primary use case.

Use `--threads` to adjust CPU parallelism (default 4), `--port` to choose another
port, or `--cache-dir` to relocate the unpacked-model cache. Both the full model and
temporary unpacking buffers need RAM; the download size is not its memory usage.
Keep this process running while using dictation, or configure it with your own
service manager. Press Ctrl+C to stop it.

Health check and a direct transcription test:

```sh
curl http://127.0.0.1:8765/health
curl -F file=@recording.wav -F model=underdog-bark-3.0-clean \
  http://127.0.0.1:8765/audio/transcriptions
```

## Tests

`test_shim.py` covers the multipart parser, the StepAudio SSE parser, and the HTTP endpoints (with ffmpeg and the vendor call stubbed out). Standard library only:

```sh
python3 test_shim.py
python3 test_bark_shim.py
```

The Bark HTTP tests use a fake backend: no model download, PyTorch, or ffmpeg is
needed. For a runtime smoke test, start `bark_shim.py` and use the curl command above
with a short English recording.

## Credit

Thanks to [@ErogosZhou](https://github.com/ErogosZhou) for the original StepAudio shim that this example is built on: https://gist.github.com/ErogosZhou/4eb2c4bab1059b404fb652df7bfe24ac

Addresses issue #972.
