# ---------------------------------------------------------------------
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Qualcomm Technologies, Inc. and/or its subsidiaries.
#
# OpenWhispr sidecar: transcribes 16 kHz mono PCM WAV files with Whisper
# encoder/decoder ONNX graphs on the Qualcomm Hexagon NPU via the ONNX
# Runtime QNN Execution Provider. Adapted from Qualcomm AI Hub Apps
# (whisper_windows_py, apps/v0.40.0) utils/model.py.
#
# Protocol: one JSON message per line on stdin/stdout; logs go to stderr.
#   in:  {"id": 1, "wav": "<path>", "language": "auto"}
#   out: {"id": 1, "ok": true, "text": "..."}
#        {"id": 1, "ok": false, "error": "..."}
# The process signals readiness with {"type": "ready", "ok": true} (or
# "ok": false + "error") and shuts down on stdin EOF.
# ---------------------------------------------------------------------

import argparse
import json
import sys
import threading
import wave

import numpy as np
import onnxruntime as ort

try:
    import onnxruntime_qnn as qnn
except ImportError:  # pragma: no cover - classic EP layout (onnxruntime-qnn < 2.0)
    qnn = None

from transformers import WhisperConfig, WhisperFeatureExtractor, WhisperTokenizer

SAMPLE_RATE = 16000
MASK_NEG = -100.0

_ORT_TYPE_TO_NP_DTYPE = {
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(double)": np.float64,
    "tensor(int32)": np.int32,
    "tensor(int64)": np.int64,
    "tensor(uint16)": np.uint16,
    "tensor(uint8)": np.uint8,
}

# QNN EP options mirroring qai_hub_models' aihub_defaults().
_QNN_PROVIDER_OPTIONS = {
    "enable_htp_fp16_precision": "1",
    "htp_performance_mode": "burst",
    "htp_graph_finalization_optimization_mode": "3",
    "offload_graph_io_quantization": "1",
}


def log(message):
    print(message, file=sys.stderr, flush=True)


_qnn_ep_registered = False


def open_qnn_session(model_path):
    """Open an ORT session for model_path on the QNN (Hexagon NPU) EP."""
    global _qnn_ep_registered
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    if qnn is not None:
        # Plugin EP (onnxruntime-qnn >= 2.0.0): register the bundled plugin
        # library into plain onnxruntime, then select its devices. ORT rejects
        # a second registration in the same process, and both graphs share it.
        if not _qnn_ep_registered:
            ort.register_execution_provider_library(qnn.EP_NAME, qnn.get_library_path())
            _qnn_ep_registered = True
        devices = [d for d in ort.get_ep_devices() if d.ep_name == qnn.EP_NAME]
        if not devices:
            raise RuntimeError("Qualcomm QNN execution provider reported no devices")
        options.add_provider_for_devices(devices, _QNN_PROVIDER_OPTIONS)
        return ort.InferenceSession(model_path, sess_options=options)

    # Classic EP (onnxruntime-qnn < 2.0.0): QNN is built into onnxruntime.
    return ort.InferenceSession(
        model_path,
        sess_options=options,
        providers=["QNNExecutionProvider"],
        provider_options=[{**_QNN_PROVIDER_OPTIONS, "backend_path": "QnnHtp.dll"}],
    )


def _cast(value, ort_type):
    dtype = _ORT_TYPE_TO_NP_DTYPE.get(ort_type)
    return value.astype(dtype, copy=False) if dtype is not None else value


def read_wav(path):
    """Read a WAV file as mono float32 at the model sample rate."""
    with wave.open(path, "rb") as wav:
        rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())
        channels = wav.getnchannels()
        width = wav.getsampwidth()

    if width == 2:
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 4:
        audio = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif width == 1:
        audio = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise RuntimeError(f"Unsupported WAV sample width: {width}")

    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    if rate != SAMPLE_RATE:
        # The host converts to 16 kHz mono before the sidecar is asked; this
        # linear resample is only a safety net for unusual input.
        target_length = int(len(audio) * SAMPLE_RATE / rate)
        if target_length > 0:
            positions = np.linspace(0, len(audio) - 1, target_length, endpoint=False)
            audio = np.interp(positions, np.arange(len(audio)), audio).astype(np.float32)
    return audio


def chunk_audio(audio, chunk_seconds=30):
    chunk_length = SAMPLE_RATE * chunk_seconds
    full_chunks = len(audio) // chunk_length
    if full_chunks == 0:
        return [audio]
    chunks = list(np.array_split(audio[: full_chunks * chunk_length], full_chunks))
    tail = audio[full_chunks * chunk_length :]
    if len(tail) > 0:
        chunks.append(tail)
    return chunks


class WhisperNpuApp:
    """Whisper encoder/decoder on the QNN EP with a greedy decode loop."""

    def __init__(self, model_dir):
        self.config = WhisperConfig.from_pretrained(model_dir)
        self.config.return_dict = False
        self.config.tie_word_embeddings = False
        self.tokenizer = WhisperTokenizer.from_pretrained(model_dir)
        self.feature_extractor = WhisperFeatureExtractor.from_pretrained(model_dir)
        self.clip_segment_tokens = set(self.tokenizer.all_special_ids)

        log(f"Loading encoder from {model_dir}")
        self.encoder = open_qnn_session(model_dir + "/encoder.onnx")
        log("Encoder loaded; loading decoder")
        self.decoder = open_qnn_session(model_dir + "/decoder.onnx")
        log("Decoder loaded")

        self._layout_decoder()

    def _layout_decoder(self):
        """Map the decoder graph's fixed buffers from live session metadata."""
        self._decoder_inputs = {i.name: i for i in self.decoder.get_inputs()}
        self._decoder_outputs = {o.name for o in self.decoder.get_outputs()}

        mask = self._decoder_inputs.get("attention_mask")
        if mask is None:
            raise RuntimeError("Decoder graph has no attention_mask input")
        if mask.shape[0] != 1 or mask.shape[1] != 1 or mask.shape[2] != 1:
            raise RuntimeError(f"Unexpected attention_mask shape: {mask.shape}")
        self.decode_len = int(mask.shape[3])

        self.kv_cross_names = {}
        self.kv_self_in_names = {}
        for name in self._decoder_inputs:
            if name in ("input_ids", "position_ids", "attention_mask"):
                continue
            if name.endswith("_in"):
                stem = name[: -len("_in")]
                self.kv_self_in_names[stem] = name
            else:
                self.kv_cross_names[name] = name

        # Number of decoder blocks from distinct self-cache indices.
        indices = sorted(
            int(stem[len("k_cache_self_") :])
            for stem in self.kv_self_in_names
            if stem.startswith("k_cache_self_")
        )
        if not indices:
            raise RuntimeError("Decoder graph has no k_cache_self inputs")
        self.num_blocks = len(indices)
        if indices != list(range(self.num_blocks)):
            raise RuntimeError(f"Unexpected self-cache block indices: {indices}")

        first_k = self._decoder_inputs[self.kv_self_in_names["k_cache_self_0"]]
        first_v = self._decoder_inputs[self.kv_self_in_names["v_cache_self_0"]]
        # [heads, 1, head_dim, decode_len - 1] for k; v is transposed.
        self.num_heads = int(first_k.shape[0])
        self.head_dim = int(first_k.shape[2])
        self._zero_k_cache = np.zeros(tuple(int(d) for d in first_k.shape), dtype=np.float32)
        self._zero_v_cache = np.zeros(tuple(int(d) for d in first_v.shape), dtype=np.float32)

    def transcribe(self, wav_path, language=None):
        audio = read_wav(wav_path)
        if audio.size == 0:
            return ""
        tokens = []
        for chunk in chunk_audio(audio):
            tokens.extend(self._transcribe_chunk(chunk))
        return self.tokenizer.decode(tokens, skip_special_tokens=True).strip()

    def _transcribe_chunk(self, audio):
        input_features = self.feature_extractor(
            audio, sampling_rate=SAMPLE_RATE, return_tensors="np"
        )["input_features"]

        encoder_feed = {}
        encoder_input = self.encoder.get_inputs()[0]
        encoder_feed[encoder_input.name] = _cast(input_features, encoder_input.type)
        encoder_result = self.encoder.run(
            [o.name for o in self.encoder.get_outputs()], encoder_feed
        )
        kv_cross = {
            o.name: value for o, value in zip(self.encoder.get_outputs(), encoder_result)
        }

        sot = self.config.decoder_start_token_id
        eot = self.config.eos_token_id

        output_ids = np.array([[sot]])
        attention_mask = np.full(
            (1, 1, 1, self.decode_len),
            MASK_NEG,
            dtype=_ORT_TYPE_TO_NP_DTYPE.get(
                self._decoder_inputs["attention_mask"].type, np.float32
            ),
        )
        position_ids = np.array([0], dtype=np.int32)
        kv_self = {f"k_cache_self_{i}": self._zero_k_cache for i in range(self.num_blocks)}
        kv_self.update(
            {f"v_cache_self_{i}": self._zero_v_cache for i in range(self.num_blocks)}
        )

        logits_name = "logits" if "logits" in self._decoder_outputs else None
        if logits_name is None:
            raise RuntimeError("Decoder graph has no logits output")

        for step in range(self.decode_len - 1):
            # Unmask one slot per step, right-to-left: the exported graph keeps
            # the KV cache at a fixed decode length and reads validity from the
            # mask's tail.
            attention_mask[:, :, :, self.decode_len - step - 1] = 0.0
            feed = {
                "input_ids": _cast(output_ids[:, step : step + 1], "tensor(int32)"),
                "position_ids": _cast(position_ids, "tensor(int32)"),
                "attention_mask": attention_mask,
            }
            feed.update(
                {
                    self.kv_self_in_names[stem]: _cast(
                        value,
                        self._decoder_inputs[self.kv_self_in_names[stem]].type,
                    )
                    for stem, value in kv_self.items()
                }
            )
            feed.update(
                {
                    name: _cast(value, self._decoder_inputs[name].type)
                    for name, value in kv_cross.items()
                }
            )

            output_names = [o.name for o in self.decoder.get_outputs()]
            result = self.decoder.run(output_names, feed)
            outputs = dict(zip(output_names, result))

            logits = outputs[logits_name]
            for i in range(self.num_blocks):
                kv_self[f"k_cache_self_{i}"] = outputs[f"k_cache_self_{i}_out"]
                kv_self[f"v_cache_self_{i}"] = outputs[f"v_cache_self_{i}_out"]

            output_id = np.argmax(logits, axis=1).reshape(1, 1)
            finished = step == self.decode_len - 2 or int(output_id[0, 0]) == eot
            output_ids = np.concatenate((output_ids, output_id), axis=-1)
            if finished:
                break
            position_ids = position_ids + 1

        return output_ids[0].tolist()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True, help="Directory with encoder/decoder ONNX plus tokenizer/config files")
    args = parser.parse_args()

    app = None
    load_error = None
    try:
        app = WhisperNpuApp(args.model_dir)
    except Exception as error:  # noqa: BLE001 - reported to the host verbatim
        load_error = f"{type(error).__name__}: {error}"
        log(f"Model load failed: {load_error}")

    print(json.dumps({"type": "ready", "ok": app is not None, "error": load_error}), flush=True)

    if app is None:
        return

    lock = threading.Lock()

    def handle(line):
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            _emit({"ok": False, "error": f"invalid request: {error}"})
            return
        request_id = request.get("id")
        try:
            wav_path = request["wav"]
            with lock:
                text = app.transcribe(wav_path, request.get("language"))
            _emit({"id": request_id, "ok": True, "text": text})
        except Exception as error:  # noqa: BLE001 - reported to the host verbatim
            _emit({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})

    def _emit(payload):
        print(json.dumps(payload), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if line:
            handle(line)


if __name__ == "__main__":
    main()
