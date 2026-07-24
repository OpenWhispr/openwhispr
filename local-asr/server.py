#!/usr/bin/env python3
"""Local OpenAI-compatible Qwen3-ASR server for OpenWhispr.

The service deliberately has no authentication and only binds to loopback by
default. OpenWhispr posts recorded audio to /audio/transcriptions and receives
the usual {"text": "..."} response.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import av
import numpy as np

HOST = os.environ.get("QWEN_ASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("QWEN_ASR_PORT", "8765"))
MODEL_ID = os.environ.get("QWEN_ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")
MAX_BODY_BYTES = int(os.environ.get("QWEN_ASR_MAX_BODY_BYTES", str(25 * 1024 * 1024)))
LAZY_LOAD = os.environ.get("QWEN_ASR_LAZY_LOAD", "0") == "1"

_session: Any | None = None
_session_lock = threading.Lock()
_inference_lock = threading.Lock()
_loaded_at: float | None = None


def parse_multipart_form(
    body: bytes, content_type: str
) -> tuple[dict[str, str], dict[str, tuple[str, bytes]]]:
    """Parse the small multipart subset used by OpenWhispr without extra deps."""
    match = re.search(r'boundary="?([^";]+)"?', content_type)
    if not match:
        raise ValueError("missing multipart boundary in Content-Type")

    delimiter = b"--" + match.group(1).strip().encode()
    fields: dict[str, str] = {}
    files: dict[str, tuple[str, bytes]] = {}

    for chunk in body.split(delimiter):
        if not chunk or chunk.startswith(b"--"):
            continue
        chunk = chunk.removeprefix(b"\r\n").removesuffix(b"\r\n")
        if b"\r\n\r\n" not in chunk:
            continue
        raw_headers, content = chunk.split(b"\r\n\r\n", 1)
        disposition = next(
            (
                line
                for line in raw_headers.decode("utf-8", "replace").split("\r\n")
                if line.lower().startswith("content-disposition:")
            ),
            "",
        )
        name_match = re.search(r'name="([^"]*)"', disposition)
        if not name_match:
            continue
        field_name = name_match.group(1)
        filename_match = re.search(r'filename="([^"]*)"', disposition)
        if filename_match:
            files[field_name] = (filename_match.group(1), content)
        else:
            fields[field_name] = content.decode("utf-8", "replace")

    return fields, files


def get_session() -> Any:
    """Load the MLX model once and retain it for low-latency requests."""
    global _session, _loaded_at
    if _session is not None:
        return _session

    with _session_lock:
        if _session is None:
            print(f"[local-asr] Loading {MODEL_ID}; first start may download model weights.")
            started = time.perf_counter()
            from mlx_qwen3_asr import Session

            _session = Session(MODEL_ID)
            _loaded_at = time.time()
            elapsed = time.perf_counter() - started
            print(f"[local-asr] Model ready in {elapsed:.2f}s.")
    return _session


def decode_audio(audio_path: str) -> np.ndarray:
    """Decode WebM/Opus and other containers to mono 16 kHz float32 in-process."""
    chunks: list[np.ndarray] = []
    with av.open(audio_path) as container:
        if not container.streams.audio:
            raise ValueError("uploaded file contains no audio stream")
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                chunks.append(converted.to_ndarray().reshape(-1))
        for converted in resampler.resample(None):
            chunks.append(converted.to_ndarray().reshape(-1))

    if not chunks:
        raise ValueError("uploaded audio contains no samples")
    return np.concatenate(chunks).astype(np.float32, copy=False)


def transcribe(audio_path: str, language: str | None, prompt: str | None) -> dict[str, Any]:
    """Run one request at a time; a single MLX session is not assumed thread-safe."""
    with _inference_lock:
        started = time.perf_counter()
        audio = decode_audio(audio_path)
        result = get_session().transcribe(
            audio,
            language=language or None,
            context=(prompt or "").strip(),
            verbose=False,
        )
        elapsed = time.perf_counter() - started
    return {
        "text": result.text or "",
        "language": result.language or "",
        "model": MODEL_ID,
        "duration_ms": round(elapsed * 1000),
        "object": "transcription",
    }


class LocalAsrHandler(BaseHTTPRequestHandler):
    server_version = "OpenWhisprLocalQwenASR/1.0"

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in ("", "/health"):
            self._send_json(404, {"error": "not found"})
            return
        self._send_json(
            200,
            {
                "status": "ready" if _session is not None else "loading",
                "model": MODEL_ID,
                "loaded_at": _loaded_at,
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in (
            "/audio/transcriptions",
            "/v1/audio/transcriptions",
        ):
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

        try:
            fields, files = parse_multipart_form(
                self.rfile.read(length), self.headers.get("Content-Type", "")
            )
        except ValueError as exc:
            self._send_json(400, {"error": f"bad multipart: {exc}"})
            return

        if "file" not in files:
            self._send_json(400, {"error": "missing 'file' field"})
            return

        filename, file_bytes = files["file"]
        suffix = Path(filename).suffix[:12] or ".webm"
        temp_path = ""
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as audio_file:
                audio_file.write(file_bytes)
                temp_path = audio_file.name
            payload = transcribe(
                temp_path,
                fields.get("language") or None,
                fields.get("prompt") or None,
            )
            self._send_json(200, payload)
        except Exception as exc:
            print(f"[local-asr] Transcription failed: {exc}")
            self._send_json(500, {"error": f"transcription failed: {exc}"})
        finally:
            if temp_path:
                Path(temp_path).unlink(missing_ok=True)


def main() -> None:
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        print(f"[local-asr] Warning: binding unauthenticated API to {HOST}.")
    if not LAZY_LOAD:
        get_session()

    # MLX's default Metal stream is thread-local. Keep model loading and all
    # inference on this main thread; requests are intentionally serialized.
    server = HTTPServer((HOST, PORT), LocalAsrHandler)
    print(f"[local-asr] Listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[local-asr] Shutting down.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
