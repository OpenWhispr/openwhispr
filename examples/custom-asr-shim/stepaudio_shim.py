#!/usr/bin/env python3
"""Local shim that bridges OpenWhispr's Self-Hosted transcription to
StepFun's StepAudio 2.5 ASR API.

OpenWhispr POSTs OpenAI-style multipart/form-data and expects JSON {"text": ...}.
StepAudio wants raw PCM (base64) over an SSE endpoint. This shim transcodes the
recording, calls StepAudio, parses the SSE stream, and hands the transcript back.

Ported from @ErogosZhou's original StepAudio shim:
https://gist.github.com/ErogosZhou/4eb2c4bab1059b404fb652df7bfe24ac

Run it: export STEP_API_KEY=...  then  python3 stepaudio_shim.py
Then in OpenWhispr: Settings -> Transcription -> Self-Hosted,
Server URL http://localhost:8765. See README.md for the full contract.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765
MAX_BODY_BYTES = 25 * 1024 * 1024  # reject anything larger than ~25 MB (HTTP 413)
ASR_URL = "https://api.stepfun.com/v1/audio/asr/sse"
API_KEY = os.environ.get("STEP_API_KEY", "")
REQUEST_TIMEOUT = 120  # seconds for the StepAudio call


def parse_multipart_form(body: bytes, content_type: str) -> tuple[dict[str, str], dict[str, tuple[str, bytes]]]:
    """Parse multipart/form-data into (text_fields, files). files maps name -> (filename, bytes).
    Stdlib-only; works on Python 3.8-3.13+ (the cgi module was removed in 3.13)."""
    m = re.search(r'boundary="?([^";]+)"?', content_type)
    if not m:
        raise ValueError("missing multipart boundary in Content-Type")
    delim = b"--" + m.group(1).strip().encode()
    fields: dict[str, str] = {}
    files: dict[str, tuple[str, bytes]] = {}
    for chunk in body.split(delim):
        if not chunk or chunk.startswith(b"--"):  # preamble, closing delimiter
            continue
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]
        if b"\r\n\r\n" not in chunk:
            continue
        raw_headers, content = chunk.split(b"\r\n\r\n", 1)
        disposition = ""
        for line in raw_headers.decode("utf-8", "replace").split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                disposition = line
        name_match = re.search(r'name="([^"]*)"', disposition)
        if not name_match:
            continue
        name = name_match.group(1)
        file_match = re.search(r'filename="([^"]*)"', disposition)
        if file_match is not None:
            files[name] = (file_match.group(1), content)
        else:
            fields[name] = content.decode("utf-8", "replace")
    return fields, files


def convert_audio(input_path: str) -> str:
    """Transcode any input container to raw 16 kHz mono s16le PCM via ffmpeg.
    StepAudio wants raw PCM here, not a WAV container. Caller owns cleanup."""
    fd, out_path = tempfile.mkstemp(suffix=".pcm")
    os.close(fd)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", input_path, "-ar", "16000", "-ac", "1",
             "-f", "s16le", out_path],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        os.remove(out_path)
        raise
    return out_path


def parse_sse_transcript(raw: bytes) -> str:
    """Parse StepAudio's SSE stream. Accumulate transcript.text.delta events and
    prefer the transcript.text.done full text. Falls back to the `type` field
    inside the data payload when the event name is absent."""
    deltas: list[str] = []
    done_text = ""
    for block in raw.split(b"\n\n"):
        if not block.strip():
            continue
        event = ""
        data_parts: list[str] = []
        for line in block.split(b"\n"):
            line = line.strip()
            if line.startswith(b"event:"):
                event = line[len(b"event:"):].strip().decode("utf-8", "replace")
            elif line.startswith(b"data:"):
                data_parts.append(line[len(b"data:"):].strip().decode("utf-8", "replace"))
        data_str = "".join(data_parts)
        if not data_str or data_str == "[DONE]":
            continue
        try:
            payload = json.loads(data_str)
        except json.JSONDecodeError:
            continue
        kind = event or payload.get("type", "")
        if kind == "transcript.text.delta":
            delta = payload.get("delta")
            if isinstance(delta, str):
                deltas.append(delta)
        elif kind == "transcript.text.done":
            text = payload.get("text")
            if isinstance(text, str):
                done_text = text
    return done_text or "".join(deltas)


def transcribe(audio_path: str, model: str, language: str | None, prompt: str | None) -> str:
    """Send the raw PCM to StepAudio 2.5 and return the transcript.
    `model`/`language` from OpenWhispr are available but StepAudio is pinned to
    its own model + language here; wire them through if you want."""
    with open(audio_path, "rb") as f:
        pcm = f.read()
    audio_b64 = base64.b64encode(pcm).decode("ascii")
    payload = {
        "audio": {
            "data": audio_b64,
            "input": {
                "transcription": {
                    "model": "stepaudio-2.5-asr",
                    "language": "zh",
                    "enable_itn": True,
                },
                "format": {
                    "type": "pcm",
                    "codec": "pcm_s16le",
                    "rate": 16000,
                    "bits": 16,
                    "channel": 1,
                },
            },
        }
    }
    req = urllib.request.Request(
        ASR_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"StepAudio HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"StepAudio request failed: {exc.reason}") from exc
    return parse_sse_transcript(raw)


class ShimHandler(BaseHTTPRequestHandler):
    """Handles the single POST endpoint OpenWhispr calls."""

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 (http.server naming)
        if self.path.rstrip("/") not in ("/audio/transcriptions", "/v1/audio/transcriptions"):
            self._send_json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "invalid Content-Length"})
            return
        if length <= 0:
            self._send_json(400, {"error": "empty body"})
            return
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "request body too large"})
            return

        body = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        try:
            fields, files = parse_multipart_form(body, content_type)
        except ValueError as exc:
            self._send_json(400, {"error": f"bad multipart: {exc}"})
            return

        if "file" not in files:
            self._send_json(400, {"error": "missing 'file' field"})
            return

        filename, file_bytes = files["file"]
        model = fields.get("model", "")
        language = fields.get("language") or None
        prompt = fields.get("prompt") or None

        suffix = os.path.splitext(filename)[1] or ".webm"
        fd, in_path = tempfile.mkstemp(suffix=suffix)
        pcm_path = None
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(file_bytes)
            pcm_path = convert_audio(in_path)
            text = transcribe(pcm_path, model, language, prompt)
            self._send_json(200, {"text": text or "", "object": "transcription"})
        except FileNotFoundError:
            self._send_json(500, {"error": "ffmpeg not found on PATH"})
        except subprocess.CalledProcessError:
            self._send_json(500, {"error": "ffmpeg failed to transcode audio"})
        except RuntimeError as exc:  # network / vendor errors
            self._send_json(500, {"error": str(exc)})
        except Exception as exc:  # surface, never swallow
            self._send_json(500, {"error": f"transcription failed: {exc}"})
        finally:
            for path in (in_path, pcm_path):
                if path and os.path.exists(path):
                    os.remove(path)


def main() -> None:
    if not API_KEY:
        print("error: STEP_API_KEY is not set. Run: export STEP_API_KEY=...", file=sys.stderr)
        sys.exit(1)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), ShimHandler)
    server.daemon_threads = True  # let Ctrl+C exit even with a request in flight
    print(f"StepAudio shim listening on http://localhost:{PORT}")
    print("Point OpenWhispr at it: Settings -> Transcription -> Self-Hosted")
    print(f"  Server URL: http://localhost:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
