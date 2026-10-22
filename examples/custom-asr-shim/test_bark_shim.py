#!/usr/bin/env python3
"""Bark adapter HTTP contract tests; stdlib only, no model or ffmpeg needed."""

import http.client
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import bark_shim
import shim_template
from test_shim import build_multipart


class BarkBackendValidationTests(unittest.TestCase):
    def test_long_recordings_are_rejected_before_loading_audio(self):
        backend = object.__new__(bark_shim.BarkBackend)
        backend.sf = SimpleNamespace(
            info=lambda _: SimpleNamespace(duration=601),
            read=Mock(side_effect=AssertionError("must not load oversized audio")),
        )
        with self.assertRaisesRegex(ValueError, "ten minutes"):
            backend.transcribe("unused.wav", "", None, None)
        backend.sf.read.assert_not_called()


class BarkHttpTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.temporary = tempfile.TemporaryDirectory()
        wav = Path(self.temporary.name) / "converted.wav"

        def convert_audio(path):
            wav.write_bytes(Path(path).read_bytes())
            return str(wav)

        self.converter = patch.object(shim_template, "convert_audio", convert_audio)
        self.converter.start()
        self.server = bark_shim.ThreadingHTTPServer(("127.0.0.1", 0), bark_shim.BarkHandler)
        calls = self.calls

        class FakeBackend:
            def transcribe(self, audio_path, model, language, prompt):
                calls.append((Path(audio_path).read_bytes(), model, language, prompt))
                return "Clean local transcript."

        self.server.bark_backend = FakeBackend()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.converter.stop()
        self.temporary.cleanup()

    def request(self, path, model=b"", language=b"en", file=b"audio"):
        parts = [("model", None, model, None), ("language", None, language, None)]
        if file is not None:
            parts.append(("file", "audio.webm", file, b"audio/webm"))
        body = build_multipart(b"BarkBoundary", parts)
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request("POST", path, body, {
                "Content-Type": "multipart/form-data; boundary=BarkBoundary",
            })
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_transcription_routes_return_openai_text_and_remove_temp_audio(self):
        for path in ("/audio/transcriptions", "/v1/audio/transcriptions"):
            with self.subTest(path=path):
                status, data = self.request(path, model=bark_shim.MODEL_ID.encode())
                self.assertEqual(status, 200)
                self.assertEqual(data["text"], "Clean local transcript.")
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0], (b"audio", bark_shim.MODEL_ID, "en", None))
        self.assertEqual(list(Path(self.temporary.name).iterdir()), [])

    def test_empty_model_uses_the_loaded_model(self):
        status, _ = self.request("/audio/transcriptions")
        self.assertEqual(status, 200)

    def test_unsupported_model_or_language_is_rejected_without_inference(self):
        for fields in ({"model": b"whisper-1"}, {"language": b"fr"}):
            with self.subTest(fields=fields):
                status, data = self.request("/audio/transcriptions", **fields)
                self.assertEqual(status, 400)
                self.assertIn("error", data)
        self.assertEqual(self.calls, [])
        self.assertEqual(list(Path(self.temporary.name).iterdir()), [])

    def test_missing_file_and_unknown_route_are_rejected(self):
        self.assertEqual(self.request("/audio/transcriptions", file=None)[0], 400)
        self.assertEqual(self.request("/other")[0], 404)
        self.assertEqual(self.calls, [])

    def test_health_and_model_discovery(self):
        for path in ("/health", "/models", "/v1/models"):
            with self.subTest(path=path):
                connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
                try:
                    connection.request("GET", path)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    data = json.loads(response.read())
                    if path == "/health":
                        self.assertTrue(data["ready"])
                        self.assertEqual(data["device"], "cpu")
                    else:
                        self.assertEqual(data["data"][0]["id"], bark_shim.MODEL_ID)
                finally:
                    connection.close()


if __name__ == "__main__":
    unittest.main()
