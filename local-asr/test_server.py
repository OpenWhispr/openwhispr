from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import av
import numpy as np
import server


class MultipartParserTest(unittest.TestCase):
    def test_parses_openwhispr_request(self) -> None:
        boundary = "openwhispr-test"
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="language"\r\n\r\n'
            "zh\r\n"
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="prompt"\r\n\r\n'
            "OpenWhispr Qwen3-ASR\r\n"
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n'
            "Content-Type: audio/webm\r\n\r\n"
        ).encode() + b"\x00\x01audio" + f"\r\n--{boundary}--\r\n".encode()

        fields, files = server.parse_multipart_form(
            body, f"multipart/form-data; boundary={boundary}"
        )

        self.assertEqual(fields["language"], "zh")
        self.assertEqual(fields["prompt"], "OpenWhispr Qwen3-ASR")
        self.assertEqual(files["file"], ("audio.webm", b"\x00\x01audio"))

    def test_rejects_missing_boundary(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing multipart boundary"):
            server.parse_multipart_form(b"", "application/json")


class AudioDecodeTest(unittest.TestCase):
    def test_decodes_openwhispr_webm_opus(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as output_file:
            output_path = output_file.name
        try:
            with av.open(output_path, "w", format="webm") as container:
                stream = container.add_stream("libopus", rate=16000)
                stream.layout = "mono"
                frame = av.AudioFrame.from_ndarray(
                    np.zeros((1, 16000), dtype=np.float32),
                    format="fltp",
                    layout="mono",
                )
                frame.sample_rate = 16000
                for packet in stream.encode(frame):
                    container.mux(packet)
                for packet in stream.encode():
                    container.mux(packet)

            audio = server.decode_audio(output_path)
            self.assertEqual(audio.dtype, np.float32)
            self.assertGreaterEqual(len(audio), 15900)
            self.assertLessEqual(len(audio), 16100)
        finally:
            Path(output_path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
