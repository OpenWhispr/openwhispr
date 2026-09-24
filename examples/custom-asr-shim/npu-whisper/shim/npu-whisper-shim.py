#!/usr/bin/env python3
"""
NPU-accelerated Whisper ASR shim for OpenWhispr Self-Hosted transcription.

Runs whisper-large-v3-turbo on Intel AI Boost NPU via OpenVINO GenAI.
Compatible with the OpenWhispr Self-Hosted wire contract:

  POST /audio/transcriptions  (multipart/form-data)
  Fields: file, model, language, prompt
  Response: {"text": "...", "object": "transcription"}

Based on OpenWhispr's examples/custom-asr-shim/shim_template.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(SCRIPT_DIR, "whisper-large-v3-turbo-fp16-ov-npu")
CACHE_DIR = os.path.join(SCRIPT_DIR, "npu_cache")
DEVICE = os.environ.get("WHISPER_DEVICE", "NPU")
PORT = int(os.environ.get("WHISPER_PORT", "8765"))
MAX_BODY_BYTES = 25 * 1024 * 1024
MIN_PYTHON = (3, 8)
ALLOWED_AUDIO_MIME = {"audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg",
                       "audio/wav", "audio/x-wav", "audio/wave",
                       "video/webm", "audio/opus"}


def _find_ffmpeg() -> str:
    """Locate ffmpeg: bundled OpenWhispr copy first, then PATH."""
    candidates = []
    # OpenWhispr bundles ffmpeg-static
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        candidates.append(os.path.join(
            local_app_data, "Programs", "OpenWhispr", "resources",
            "app.asar.unpacked", "node_modules", "ffmpeg-static", "ffmpeg.exe"))
    candidates.append("ffmpeg")
    for p in candidates:
        try:
            subprocess.run([p, "-version"], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=True)
            return p
        except (subprocess.CalledProcessError, FileNotFoundError, OSError):
            continue
    return "ffmpeg"  # let it fail with a clear error later


FFMPEG = _find_ffmpeg()

# ---------------------------------------------------------------------------
# Early validation
# ---------------------------------------------------------------------------
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

if sys.version_info < MIN_PYTHON:
    sys.exit(f"Python {'.'.join(map(str, MIN_PYTHON))}+ required, got {sys.version}")

if not os.path.isdir(MODEL_DIR):
    sys.exit(
        f"Model directory not found: {MODEL_DIR}\n"
        f"Download: huggingface_hub.snapshot_download('movensys/whisper-large-v3-turbo-fp16-ov-npu', local_dir='{MODEL_DIR}')"
    )

os.makedirs(CACHE_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# V5: Verify OpenVINO package versions match (ABI mismatch = silent crash)
# ---------------------------------------------------------------------------
try:
    import importlib.metadata as _md
    _pkg_versions = {}
    for _pkg in ["openvino", "openvino-genai", "openvino-tokenizers"]:
        try:
            _pkg_versions[_pkg] = _md.version(_pkg)
        except _md.PackageNotFoundError:
            _pkg_versions[_pkg] = None
            print(f"[warn] {_pkg} not installed — will crash at pipeline load", flush=True)

    _ov_versions = set(v for v in _pkg_versions.values() if v is not None)
    if len(_ov_versions) > 1:
        print(f"[warn] OpenVINO version mismatch: {_pkg_versions} — may cause ABI crash", flush=True)
    else:
        for p, v in _pkg_versions.items():
            print(f"[version] {p}=={v}", flush=True)
except Exception:
    pass  # version check is advisory only; don't block startup

# ---------------------------------------------------------------------------
# Pipeline manager (lazy-load, cache forever, thread-safe init)
# ---------------------------------------------------------------------------

_pipeline = None
_pipeline_lock = threading.Lock()
_start_time = time.time()
_total_requests = 0
_total_errors = 0
_request_counter = 0
F32_DUMP_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "logs", "f32_dumps")


def _init_pipeline():
    """Create the WhisperPipeline on NPU.  First call compiles (2-5 min);
    subsequent imports hit the CACHE_DIR and load in ~1-3 seconds."""
    import openvino_genai as ov_genai

    print(f"[pipeline] Loading model on {DEVICE} from {MODEL_DIR} ...", flush=True)
    t0 = time.time()

    pipe = ov_genai.WhisperPipeline(str(MODEL_DIR), DEVICE,
                                    **{"CACHE_DIR": str(CACHE_DIR)})

    elapsed = time.time() - t0
    print(f"[pipeline] Ready in {elapsed:.1f}s", flush=True)

    # Dump generation config for debugging
    gencfg = pipe.get_generation_config()
    print(f"[pipeline] max_new_tokens={gencfg.max_new_tokens}", flush=True)
    return pipe


def get_pipeline():
    """Thread-safe singleton accessor.  Blocks concurrent callers
    while the pipeline is initialising, then returns the same instance."""
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    with _pipeline_lock:
        if _pipeline is None:       # double-check
            _pipeline = _init_pipeline()
    return _pipeline

# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def convert_audio(input_bytes: bytes, suffix: str = ".webm") -> str:
    """Transcode any audio container to 16 kHz mono WAV via ffmpeg.
    Returns path to a new temp WAV; caller owns cleanup."""
    fd, out_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)

    fd_in, in_path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd_in, "wb") as f:
        f.write(input_bytes)

    try:
        subprocess.run(
            [FFMPEG, "-y", "-i", in_path,
             "-ar", "16000", "-ac", "1", "-f", "wav", out_path],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as exc:
        stderr_text = exc.stderr.decode("utf-8", "replace") if exc.stderr else ""
        raise RuntimeError(f"ffmpeg failed: {stderr_text[:500]}") from exc
    finally:
        if os.path.exists(in_path):
            os.remove(in_path)

    return out_path


def load_audio_float(wav_path: str) -> list[float]:
    """Load a 16 kHz mono WAV into a flat list of floats.
    Properly scans for the 'data' chunk instead of assuming 44-byte header.
    Handles ffmpeg's metadata chunks (LIST/INFO etc)."""
    import numpy as np
    import struct

    with open(wav_path, 'rb') as f:
        # Read RIFF header
        riff = f.read(4)
        if riff != b'RIFF':
            raise ValueError(f"Not a valid WAV: {wav_path}")
        f.read(4)  # file size
        wave = f.read(4)
        if wave != b'WAVE':
            raise ValueError(f"Not WAVE format: {wav_path}")

        bits = 16
        channels = 1
        sr_val = 16000
        data_bytes = None

        # Scan chunks until we find 'data'
        while True:
            chunk_id = f.read(4)
            if len(chunk_id) < 4:
                break
            chunk_size = struct.unpack('<I', f.read(4))[0]

            if chunk_id == b'fmt ':
                fmt_data = f.read(chunk_size)
                audio_fmt = struct.unpack_from('<H', fmt_data, 0)[0]
                channels = struct.unpack_from('<H', fmt_data, 2)[0]
                sr_val = struct.unpack_from('<I', fmt_data, 4)[0]
                bits = struct.unpack_from('<H', fmt_data, 14)[0]
                if audio_fmt not in (1, 3):
                    raise ValueError(f"Unsupported WAV format: {audio_fmt} (expected PCM=1 or float=3)")
            elif chunk_id == b'data':
                data_bytes = f.read(chunk_size)
                break
            else:
                f.seek(chunk_size, 1)  # skip unknown chunks

        if data_bytes is None:
            raise ValueError(f"No data chunk found in WAV: {wav_path}")

    if bits == 16:
        arr = np.frombuffer(data_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    elif bits == 32:
        arr = np.frombuffer(data_bytes, dtype=np.float32)
    else:
        raise ValueError(f"Unsupported WAV bit depth: {bits}")

    if channels > 1:
        arr = arr.reshape(-1, channels).mean(axis=1)

    return arr.tolist()

# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

def transcribe(audio_path: str, model: str | None,
               language: str | None, prompt: str | None) -> str:
    """Run inference on the NPU and return the transcript."""
    audio = load_audio_float(audio_path)
    return _run_inference(audio, language, prompt, dump_label="transcribe_fn")


def _run_inference(audio: list[float], language: str | None,
                   prompt: str | None, dump_label: str = "") -> str:
    """Core inference: pre-loaded float32 audio -> text.
    Saves a permanent .f32 dump for comparison diagnostics."""
    global _request_counter
    _request_counter += 1
    duration_s = len(audio) / 16000
    max_tokens = max(20, int(duration_s * 10))

    gen_args = {}
    if language:
        gen_args["language"] = f"<|{language}|>"
    # NOTE: initial_prompt causes NPU static-shape tensor error:
    #   Check '*roi_end <= *max_dim' failed at make_tensor.cpp:35
    # The prompt prepends context tokens to the decoder which conflicts
    # with the NPU-compiled model's static output dimensions.
    if prompt and prompt.strip():
        print(f"[warn] initial_prompt dropped (incompatible with NPU static shapes): "
              f"'{prompt[:60]}'", flush=True)
    # initial_prompt intentionally omitted for NPU compatibility

    # ---- Diagnostic dump: save .f32 and .json permanently ----
    import json as _json, struct as _struct, hashlib
    os.makedirs(F32_DUMP_DIR, exist_ok=True)
    dump_id = f"{_request_counter:04d}_{dump_label}_{len(audio)}samples"
    f32_dump_path = os.path.join(F32_DUMP_DIR, f"{dump_id}.f32")
    json_dump_path = os.path.join(F32_DUMP_DIR, f"{dump_id}.json")

    with open(f32_dump_path, 'wb') as f:
        f.write(_struct.pack(f'{len(audio)}f', *audio))
    with open(json_dump_path, 'w') as f:
        _json.dump({
            'max_tokens': max_tokens,
            'gen_args': gen_args,
            'duration_s': duration_s,
            'num_samples': len(audio),
            'dump_label': dump_label,
            'request_num': _request_counter,
        }, f, indent=2)

    f32_hash = hashlib.sha256(open(f32_dump_path, 'rb').read()).hexdigest()[:16]
    print(f"[dump] saved {dump_id}.f32 (sha256={f32_hash})", flush=True)

    # V6: Limit dump accumulation — keep last 200 files (100 pairs)
    _all_dumps = sorted(
        [os.path.join(F32_DUMP_DIR, fn) for fn in os.listdir(F32_DUMP_DIR)
         if fn.endswith('.f32') or fn.endswith('.json')],
        key=os.path.getmtime
    )
    while len(_all_dumps) > 200:
        try:
            os.remove(_all_dumps.pop(0))
        except OSError:
            break
    # ---- End diagnostic dump ----

    pipe = get_pipeline()
    t0 = time.time()

    try:
        result = pipe.generate(audio, max_new_tokens=max_tokens, **gen_args)
    except RuntimeError as e:
        msg = str(e)
        print(f"[transcribe] FAILED: {msg[:120]}", flush=True)
        raise

    elapsed = time.time() - t0
    text = str(result) if result else ""
    print(f"[transcribe] {duration_s:.1f}s audio -> "
          f"{len(text)} chars in {elapsed:.1f}s "
          f"(RTF: {elapsed / max(duration_s, 0.01):.2f}x)", flush=True)
    return text

# ---------------------------------------------------------------------------
# Multipart parser (stdlib-only, Python 3.8-3.13+)
# ---------------------------------------------------------------------------

def parse_multipart_form(body: bytes, content_type: str
                         ) -> tuple[dict[str, str], dict[str, tuple[str, bytes, str]]]:
    m = re.search(r'boundary="?([^";]+)"?', content_type)
    if not m:
        raise ValueError("missing multipart boundary in Content-Type")
    delim = b"--" + m.group(1).strip().encode()
    fields: dict[str, str] = {}
    files: dict[str, tuple[str, bytes]] = {}
    for chunk in body.split(delim):
        if not chunk or chunk.startswith(b"--"):
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
            # Extract Content-Type if available
            file_ct = "application/octet-stream"
            for line in raw_headers.decode("utf-8", "replace").split("\r\n"):
                if line.lower().startswith("content-type:"):
                    file_ct = line.split(":", 1)[1].strip().lower()
                    if ";" in file_ct:
                        file_ct = file_ct.split(";")[0].strip()
                    break
            files[name] = (file_match.group(1), content, file_ct)
        else:
            fields[name] = content.decode("utf-8", "replace")
    return fields, files

# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class ShimHandler(BaseHTTPRequestHandler):
    server_version = "OpenWhispr-NPU-Shim/1.0"

    def log_message(self, fmt, *args):
        print(f"[http] {self.client_address[0]} - {fmt % args}", flush=True)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
        self.end_headers()

    def do_GET(self) -> None:
        global _total_requests, _total_errors
        path = self.path.rstrip("/")

        if path == "" or path == "/":
            self._send_json(200, {
                "service": "OpenWhispr NPU Whisper Shim",
                "device": DEVICE,
                "model": "whisper-large-v3-turbo",
                "format": "fp16",
                "backend": "OpenVINO GenAI",
                "uptime_s": int(time.time() - _start_time),
                "requests": _total_requests,
                "errors": _total_errors,
            })
            return

        if path == "/health":
            pipe = get_pipeline()
            self._send_json(200, {
                "status": "ok",
                "device": DEVICE,
                "pipeline_loaded": pipe is not None,
            })
            return

        if path == "/dumps":
            dumps = []
            if os.path.isdir(F32_DUMP_DIR):
                for fn in sorted(os.listdir(F32_DUMP_DIR)):
                    f32p = os.path.join(F32_DUMP_DIR, fn)
                    dumps.append({
                        "name": fn,
                        "size": os.path.getsize(f32p),
                    })
            self._send_json(200, {
                "count": len(dumps),
                "dumps": dumps[-20:],  # last 20
            })
            return

        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        global _total_requests, _total_errors
        path = self.path.rstrip("/")

        if path not in ("/audio/transcriptions", "/v1/audio/transcriptions",
                        "/transcribe", "/inference"):
            self._send_json(404, {"error": "not found"})
            return

        _total_requests += 1

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

        filename, file_bytes, file_mime = files["file"]
        model = fields.get("model") or None
        language = fields.get("language") or None
        prompt = fields.get("prompt") or None

        # V3: Validate uploaded audio MIME type
        mime_normalized = file_mime.split(";")[0].strip().lower()
        if mime_normalized not in ALLOWED_AUDIO_MIME and mime_normalized != "application/octet-stream":
            self._send_json(400, {"error": f"unsupported audio type: {mime_normalized}"})
            return

        # Dump received audio for debugging
        import hashlib
        audio_hash = hashlib.sha256(file_bytes).hexdigest()[:12]

        suffix = os.path.splitext(filename)[1] or ".webm"
        wav_path = None
        dump_path = None

        try:
            # Save received bytes to disk for analysis
            fd_dump, dump_path = tempfile.mkstemp(suffix=suffix, prefix="recv_")
            with os.fdopen(fd_dump, 'wb') as f:
                f.write(file_bytes)

            wav_path = convert_audio(file_bytes, suffix)
            audio = load_audio_float(wav_path)
            dur_s = len(audio) / 16000
            import numpy as np
            rms_val = float(np.sqrt(np.mean(np.array(audio)**2)))

            print(f"[request] {len(file_bytes)}B hash={audio_hash} -> {dur_s:.1f}s rms={rms_val:.6f} saved={dump_path}", flush=True)

            if rms_val < 0.0001 or dur_s < 0.1:
                self._send_json(500, {"error": f"Audio too quiet (rms={rms_val:.6f}) or short ({dur_s:.1f}s)"})
                return

            text = _run_inference(audio, language, prompt, dump_label=f"http_{audio_hash}")
            self._send_json(200, {"text": text or "", "object": "transcription"})
            # Success - clean up dump
            if dump_path and os.path.exists(dump_path):
                os.remove(dump_path)
        except FileNotFoundError:
            _total_errors += 1
            self._send_json(500, {"error": "ffmpeg not found on PATH"})
        except subprocess.CalledProcessError:
            _total_errors += 1
            self._send_json(500, {"error": "ffmpeg failed to transcode audio"})
        except Exception:
            _total_errors += 1
            traceback.print_exc()
            self._send_json(500, {"error": "transcription failed"})
        finally:
            if wav_path and os.path.exists(wav_path):
                os.remove(wav_path)

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("  OpenWhispr NPU Whisper Shim")
    print("=" * 60)
    print(f"  Model  : {MODEL_DIR}")
    print(f"  Device : {DEVICE}")
    print(f"  Port   : {PORT}")
    print(f"  Cache  : {CACHE_DIR}")
    print("=" * 60)

    # Eager-load the pipeline at startup so the first request is fast.
    print("[startup] Pre-warming pipeline (first run compiles, 2-5 min)...")
    get_pipeline()
    print("[startup] Ready to accept requests.\n")

    server = ThreadingHTTPServer(("127.0.0.1", PORT), ShimHandler)
    server.daemon_threads = True
    print(f"Listening on http://127.0.0.1:{PORT}")
    print("Point OpenWhispr at: Settings -> STT -> Self-Hosted")
    print(f"  Server URL: http://localhost:{PORT}")
    print("Press Ctrl+C to stop.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[shutdown] Shutting down...")
    finally:
        server.server_close()
        print("[shutdown] Done.")


if __name__ == "__main__":
    main()
