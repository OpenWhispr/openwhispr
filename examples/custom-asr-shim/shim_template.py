#!/usr/bin/env python3
"""Generic local shim that lets OpenWhispr's Self-Hosted transcription talk
to an ASR backend that does NOT speak the OpenAI /audio/transcriptions
protocol.

The contract OpenWhispr speaks (verified against its source):

  - It POSTs multipart/form-data to {Server URL}/audio/transcriptions.
  - Fields: `file` (recorded audio, usually WebM/Opus, filename audio.webm),
    optional `model` (the string from the Self-Hosted panel), optional
    `language` (ISO code), optional `prompt` (custom-dictionary hint).
    Self-Hosted transcription is batch HTTP; `stream` is not used on this path.
  - Do not require Authorization from OpenWhispr. Hold vendor keys in env vars.
  - It expects HTTP 200 with JSON {"text": "..."}. Empty text shows
    "No audio detected"; non-200 is surfaced as an API error.

This file is the vendor-neutral template: fill in `transcribe()` with your
backend's call and everything else works as-is. See README.md for details.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765
MAX_BODY_BYTES = 25 * 1024 * 1024  # reject anything larger than ~25 MB (HTTP 413)
API_KEY = os.environ.get("SHIM_API_KEY", "")  # optional; set if your backend needs it


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
    """Transcode any input container to 16 kHz mono PCM WAV via ffmpeg.
    Returns the path to a new temp WAV; caller owns cleanup."""
    fd, out_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", input_path, "-ar", "16000", "-ac", "1",
             "-f", "wav", out_path],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        os.remove(out_path)
        raise
    return out_path


def transcribe(audio_path: str, model: str, language: str | None, prompt: str | None) -> str:
    """The ONLY function you edit. Call your vendor's ASR backend with the WAV at
    `audio_path` and return the transcript as a plain string.

    `model`/`language`/`prompt` come straight from OpenWhispr's UI and may be
    used or ignored. See stepaudio_shim.py for a concrete implementation."""
    raise NotImplementedError(
        "Replace transcribe() with your vendor's ASR call; return the transcript string."
    )


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
        wav_path = None
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(file_bytes)
            wav_path = convert_audio(in_path)
            text = transcribe(wav_path, model, language, prompt)
            self._send_json(200, {"text": text or "", "object": "transcription"})
        except FileNotFoundError:
            self._send_json(500, {"error": "ffmpeg not found on PATH"})
        except subprocess.CalledProcessError:
            self._send_json(500, {"error": "ffmpeg failed to transcode audio"})
        except NotImplementedError as exc:
            self._send_json(500, {"error": str(exc)})
        except Exception as exc:  # surface, never swallow
            self._send_json(500, {"error": f"transcription failed: {exc}"})
        finally:
            for path in (in_path, wav_path):
                if path and os.path.exists(path):
                    os.remove(path)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), ShimHandler)
    server.daemon_threads = True  # let Ctrl+C exit even with a request in flight
    print(f"Custom ASR shim listening on http://localhost:{PORT}")
    print("Point OpenWhispr at it: Settings -> Transcription -> Self-Hosted")
    print(f"  Server URL: http://localhost:{PORT}")
    print("  Vendor API key: hold it in an env var inside transcribe()")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
