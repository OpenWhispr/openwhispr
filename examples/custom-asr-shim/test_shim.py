#!/usr/bin/env python3
"""Unit tests for the custom ASR shim example.

Stdlib only (unittest), no network, no ffmpeg: the HTTP tests monkeypatch
`convert_audio` and `transcribe` so they exercise the request handling,
multipart parsing, and response shape in isolation.

Run from anywhere:
    python3 examples/custom-asr-shim/test_shim.py
or:
    cd examples/custom-asr-shim && python3 -m unittest
"""

from __future__ import annotations

import http.client
import json
import os
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import shim_template  # noqa: E402
import stepaudio_shim  # noqa: E402

CRLF = b"\r\n"


def build_multipart(boundary: bytes, parts) -> bytes:
    """parts: list of (name, filename|None, content_bytes, content_type|None)."""
    out = []
    for name, filename, content, ctype in parts:
        out.append(b"--" + boundary + CRLF)
        disp = b'Content-Disposition: form-data; name="' + name.encode() + b'"'
        if filename is not None:
            disp += b'; filename="' + filename.encode() + b'"'
        out.append(disp + CRLF)
        if ctype is not None:
            out.append(b"Content-Type: " + ctype + CRLF)
        out.append(CRLF)
        out.append(content + CRLF)
    out.append(b"--" + boundary + b"--" + CRLF)
    return b"".join(out)


class MultipartParserTests(unittest.TestCase):
    """The parser is duplicated verbatim in both files; test both copies."""

    modules = (shim_template, stepaudio_shim)

    def test_roundtrip_binary_with_embedded_crlf(self):
        # Binary that starts, ends, and contains CR/LF, to catch over-stripping.
        file_bytes = b"\r\n\x1aOggS\x00\x02mid\r\ndle\r\nend\r\n"
        body = build_multipart(
            b"----WebKitFormBoundaryAbC",
            [
                ("file", "audio.webm", file_bytes, b"audio/webm"),
                ("model", None, b"whisper-1", None),
                ("language", None, b"en", None),
            ],
        )
        ct = "multipart/form-data; boundary=----WebKitFormBoundaryAbC"
        for mod in self.modules:
            with self.subTest(module=mod.__name__):
                fields, files = mod.parse_multipart_form(body, ct)
                self.assertEqual(fields.get("model"), "whisper-1")
                self.assertEqual(fields.get("language"), "en")
                self.assertIn("file", files)
                filename, data = files["file"]
                self.assertEqual(filename, "audio.webm")
                self.assertEqual(data, file_bytes)  # exact byte match, no over-strip

    def test_utf8_text_field(self):
        body = build_multipart(
            b"X1",
            [
                ("file", "a.webm", b"\x00\x01", b"audio/webm"),
                ("prompt", None, "caffè, naïve, 日本語".encode("utf-8"), None),
            ],
        )
        for mod in self.modules:
            with self.subTest(module=mod.__name__):
                fields, _ = mod.parse_multipart_form(body, "multipart/form-data; boundary=X1")
                self.assertEqual(fields.get("prompt"), "caffè, naïve, 日本語")

    def test_missing_boundary_raises(self):
        for mod in self.modules:
            with self.subTest(module=mod.__name__):
                with self.assertRaises(ValueError):
                    mod.parse_multipart_form(b"whatever", "application/json")

    def test_trailing_space_boundary(self):
        # RFC-valid OWS after the boundary token must not break the delimiter.
        body = build_multipart(b"B9", [("file", "a.webm", b"data", b"audio/webm")])
        for mod in self.modules:
            with self.subTest(module=mod.__name__):
                _, files = mod.parse_multipart_form(
                    body, "multipart/form-data; boundary=B9 "
                )
                self.assertIn("file", files)
                self.assertEqual(files["file"][1], b"data")

    def test_no_file_field(self):
        body = build_multipart(b"B9", [("model", None, b"x", None)])
        for mod in self.modules:
            with self.subTest(module=mod.__name__):
                _, files = mod.parse_multipart_form(body, "multipart/form-data; boundary=B9")
                self.assertNotIn("file", files)


class SseParserTests(unittest.TestCase):
    parse = staticmethod(stepaudio_shim.parse_sse_transcript)

    def test_prefers_done_over_deltas(self):
        raw = (
            b"event: transcript.text.delta\ndata: {\"delta\": \"par\"}\n\n"
            b"event: transcript.text.delta\ndata: {\"delta\": \"tial\"}\n\n"
            b"event: transcript.text.done\ndata: {\"text\": \"full text\"}\n\n"
            b"data: [DONE]\n\n"
        )
        self.assertEqual(self.parse(raw), "full text")

    def test_delta_join_when_no_done(self):
        raw = (
            b"event: transcript.text.delta\ndata: {\"delta\": \"foo\"}\n\n"
            b"event: transcript.text.delta\ndata: {\"delta\": \"bar\"}\n\n"
        )
        self.assertEqual(self.parse(raw), "foobar")

    def test_type_field_fallback(self):
        raw = (
            b"data: {\"type\": \"transcript.text.delta\", \"delta\": \"x\"}\n\n"
            b"data: {\"type\": \"transcript.text.done\", \"text\": \"final\"}\n\n"
        )
        self.assertEqual(self.parse(raw), "final")

    def test_skips_done_marker_and_malformed_json(self):
        raw = (
            b"data: [DONE]\n\n"
            b"data: not json at all\n\n"
            b"event: transcript.text.done\ndata: {\"text\": \"ok\"}\n\n"
        )
        self.assertEqual(self.parse(raw), "ok")

    def test_empty_stream(self):
        self.assertEqual(self.parse(b""), "")


class _HandlerHarness:
    """Runs a module's ShimHandler on an ephemeral port with ffmpeg/network
    stubbed out, and restores the patched globals on stop."""

    def __init__(self, module):
        self.module = module
        self.captured = {}
        self._orig = {}

    def start(self):
        mod = self.module
        self._orig["convert_audio"] = mod.convert_audio
        self._orig["transcribe"] = mod.transcribe
        # Silence the per-request access log so test output stays readable.
        self._had_own_log = "log_message" in mod.ShimHandler.__dict__
        self._orig_log = mod.ShimHandler.__dict__.get("log_message")
        mod.ShimHandler.log_message = lambda *a, **k: None

        # No ffmpeg: hand the written input file straight through.
        mod.convert_audio = lambda path: path

        def fake_transcribe(audio_path, model, language, prompt):
            with open(audio_path, "rb") as f:
                self.captured["bytes"] = f.read()
            self.captured["model"] = model
            self.captured["language"] = language
            self.captured["prompt"] = prompt
            return "hello world"

        mod.transcribe = fake_transcribe

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), mod.ShimHandler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.module.convert_audio = self._orig["convert_audio"]
        self.module.transcribe = self._orig["transcribe"]
        if self._had_own_log:
            self.module.ShimHandler.log_message = self._orig_log
        else:
            del self.module.ShimHandler.log_message

    def post(self, path, body, content_type):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("POST", path, body, {"Content-Type": content_type})
            resp = conn.getresponse()
            return resp.status, resp.read()
        finally:
            conn.close()


class HttpHandlerTests(unittest.TestCase):
    modules = (shim_template, stepaudio_shim)

    def _valid_body(self):
        file_bytes = b"RIFFfake-wav-bytes\r\n\x00"
        body = build_multipart(
            b"HB",
            [
                ("file", "audio.webm", file_bytes, b"audio/webm"),
                ("model", None, b"my-model", None),
                ("language", None, b"en", None),
            ],
        )
        return body, file_bytes, "multipart/form-data; boundary=HB"

    def test_valid_post_returns_text_and_passes_bytes_through(self):
        body, file_bytes, ct = self._valid_body()
        for mod in self.modules:
            with self.subTest(module=mod.__name__):
                h = _HandlerHarness(mod)
                h.start()
                try:
                    for path in ("/audio/transcriptions", "/v1/audio/transcriptions"):
                        status, raw = h.post(path, body, ct)
                        self.assertEqual(status, 200)
                        payload = json.loads(raw)
                        self.assertEqual(payload["text"], "hello world")
                        self.assertEqual(payload["object"], "transcription")
                    # the exact recorded bytes reached transcribe()
                    self.assertEqual(h.captured["bytes"], file_bytes)
                    self.assertEqual(h.captured["model"], "my-model")
                    self.assertEqual(h.captured["language"], "en")
                finally:
                    h.stop()

    def test_wrong_path_404(self):
        body, _, ct = self._valid_body()
        for mod in self.modules:
            with self.subTest(module=mod.__name__):
                h = _HandlerHarness(mod)
                h.start()
                try:
                    status, _ = h.post("/nope", body, ct)
                    self.assertEqual(status, 404)
                finally:
                    h.stop()

    def test_missing_file_400(self):
        body = build_multipart(b"HB", [("model", None, b"x", None)])
        for mod in self.modules:
            with self.subTest(module=mod.__name__):
                h = _HandlerHarness(mod)
                h.start()
                try:
                    status, _ = h.post(
                        "/audio/transcriptions", body, "multipart/form-data; boundary=HB"
                    )
                    self.assertEqual(status, 400)
                finally:
                    h.stop()

    def test_oversize_body_413(self):
        body, _, ct = self._valid_body()
        for mod in self.modules:
            with self.subTest(module=mod.__name__):
                orig = mod.MAX_BODY_BYTES
                mod.MAX_BODY_BYTES = 4  # smaller than any real body
                h = _HandlerHarness(mod)
                h.start()
                try:
                    status, _ = h.post("/audio/transcriptions", body, ct)
                    self.assertEqual(status, 413)
                finally:
                    h.stop()
                    mod.MAX_BODY_BYTES = orig


if __name__ == "__main__":
    unittest.main(verbosity=2)
