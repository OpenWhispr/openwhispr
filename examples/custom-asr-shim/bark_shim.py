#!/usr/bin/env python3
"""Local CPU Bark 3.0 Clean adapter for OpenWhispr's Self-Hosted mode.

Download the published model and loader yourself; see README.md. Heavy runtime
dependencies are imported only at startup, so --help and HTTP tests use stdlib.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import logging
from pathlib import Path
import shutil
import threading
from http.server import ThreadingHTTPServer

from shim_template import ShimHandler

MODEL_ID = "underdog-bark-3.0-clean"
SAMPLE_RATE = 16000
MAX_AUDIO_SECONDS = 600
log = logging.getLogger("bark-shim")


class BarkBackend:
    def __init__(self, model_dir: Path, cache_dir: Path, threads: int):
        import numpy as np
        import soundfile as sf
        import torch
        from filelock import FileLock
        from transformers import AutoProcessor, ParakeetForTDT

        self.np, self.sf, self.torch = np, sf, torch
        self.lock = threading.Lock()
        torch.set_num_threads(threads)
        weights, loader = model_dir / "model.bark", model_dir / "bark_loader.py"
        fingerprint = hashlib.sha256()
        for path in (weights, loader):
            with path.open("rb") as source:
                while block := source.read(1024 * 1024):
                    fingerprint.update(block)
        cache_dir.mkdir(parents=True, exist_ok=True)
        runtime_dir = cache_dir / fingerprint.hexdigest()
        with FileLock(str(cache_dir / ".lock"), timeout=300):
            if (runtime_dir / ".ready").exists():
                self.model = ParakeetForTDT.from_pretrained(
                    runtime_dir, local_files_only=True
                ).eval()
                self.processor = AutoProcessor.from_pretrained(
                    runtime_dir, local_files_only=True
                )
            else:
                # Import only the explicitly selected local loader. Model code is
                # supplied by the user, not fetched/executed by this adapter.
                spec = importlib.util.spec_from_file_location("bark_loader", loader)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                self.model = module.load_model(str(weights), device="cpu")
                self.processor = AutoProcessor.from_pretrained("nvidia/parakeet-tdt-0.6b-v3")
                shutil.rmtree(runtime_dir, ignore_errors=True)
                self.model.save_pretrained(runtime_dir)
                self.processor.save_pretrained(runtime_dir)
                (runtime_dir / ".ready").touch()

    @staticmethod
    def validate_request(model: str, language: str | None):
        if model and model != MODEL_ID:
            raise ValueError(f"This adapter serves only {MODEL_ID}")
        if language and language.lower() not in {"en", "english", "auto"}:
            raise ValueError("Bark 3.0 Clean supports English only")

    def transcribe(self, audio_path, model, language, prompt):
        self.validate_request(model, language)
        info = self.sf.info(audio_path)
        if info.duration > MAX_AUDIO_SECONDS:
            raise ValueError("Audio must be ten minutes or shorter")
        wave, sr = self.sf.read(audio_path, dtype="float32", always_2d=True)
        if sr != SAMPLE_RATE:
            raise ValueError("Expected 16 kHz audio from the shim's ffmpeg conversion")
        wave = wave.mean(1)
        np = self.np
        if len(wave) < SAMPLE_RATE // 10 or np.max(np.abs(wave), initial=0) < 0.0001:
            return ""
        # Bark does not support dictionary prompting; deliberately ignore prompt.
        results = []
        with self.lock, self.torch.inference_mode():
            offset = 0
            while offset < len(wave):
                end = min(offset + 30 * SAMPLE_RATE, len(wave))
                if end < len(wave):
                    # Bound attention memory and prefer a quiet chunk boundary.
                    start = end - 5 * SAMPLE_RATE
                    windows = wave[start:end].reshape(-1, SAMPLE_RATE // 10)
                    quiet = int(np.argmin(np.mean(windows ** 2, axis=1)))
                    end = start + (quiet + 1) * (SAMPLE_RATE // 10)
                inputs = self.processor(
                    [wave[offset:end]], sampling_rate=SAMPLE_RATE,
                    return_tensors="pt", padding=True,
                )
                output = self.model.generate(**inputs)
                results.append(self.processor.batch_decode(
                    output.sequences, skip_special_tokens=True
                )[0].strip())
                offset = end
        return " ".join(text for text in results if text)


class BarkHandler(ShimHandler):
    def transcribe_audio(self, audio_path, model, language, prompt):
        BarkBackend.validate_request(model, language)
        return self.server.bark_backend.transcribe(audio_path, model, language, prompt)

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") == "/health":
            self._send_json(200, {"ready": True, "model": MODEL_ID, "device": "cpu"})
        elif self.path.rstrip("/") in ("/models", "/v1/models"):
            self._send_json(200, {
                "object": "list",
                "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local"}],
            })
        else:
            self._send_json(404, {"error": "not found"})


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True,
                        help="directory containing model.bark and bark_loader.py")
    parser.add_argument("--cache-dir", type=Path,
                        help="unpacked-model cache (default: MODEL_DIR/.openwhispr-cache)")
    parser.add_argument("--threads", type=positive_int, default=4)
    parser.add_argument("--port", type=positive_int, default=8765)
    args = parser.parse_args()
    if args.port > 65535:
        parser.error("--port must be at most 65535")
    for name in ("model.bark", "bark_loader.py"):
        if not (args.model_dir / name).is_file():
            parser.error(f"missing {name} in --model-dir; see README.md")
    if not shutil.which("ffmpeg"):
        parser.error("ffmpeg must be installed and on PATH")

    logging.basicConfig(level=logging.INFO)
    # Bind before loading so an occupied port fails without unpacking the model.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), BarkHandler)
    server.daemon_threads = True
    try:
        log.info("Loading Bark 3.0 Clean on CPU")
        server.bark_backend = BarkBackend(
            args.model_dir, args.cache_dir or args.model_dir / ".openwhispr-cache", args.threads
        )
        log.info("Ready: set OpenWhispr's Self-Hosted Server URL to http://127.0.0.1:%s", args.port)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
