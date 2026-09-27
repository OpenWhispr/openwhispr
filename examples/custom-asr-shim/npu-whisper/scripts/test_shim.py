#!/usr/bin/env python3
"""Test script for the NPU Whisper shim.

Tests the shim's HTTP endpoint with a sample audio file from OpenWhispr's
recordings directory. Validates:
  - Health endpoint responds
  - Transcription returns valid text
  - Response format matches the OpenWhispr wire contract
"""

import os
import sys
import json
import requests

SHIM_URL = "http://127.0.0.1:8765"
AUDIO_DIR = os.path.expandvars(r"%APPDATA%\open-whispr\audio")

def test_health():
    """Verify the health endpoint responds."""
    resp = requests.get(f"{SHIM_URL}/health", timeout=10)
    assert resp.status_code == 200, f"Health check failed: {resp.status_code}"
    data = resp.json()
    assert data.get("status") == "ok", f"Unexpected health response: {data}"
    assert data.get("pipeline_loaded") is True, "Pipeline not loaded"
    print(f"[OK] Health: device={data.get('device')}")
    return True

def test_transcribe():
    """Send an audio file and verify transcription."""
    files_list = [
        f for f in os.listdir(AUDIO_DIR)
        if f.endswith(".webm") and os.path.getsize(os.path.join(AUDIO_DIR, f)) > 10000
    ]
    if not files_list:
        print("[SKIP] No suitable audio files found")
        return True

    test_file = os.path.join(AUDIO_DIR, sorted(files_list, key=lambda f: os.path.getsize(os.path.join(AUDIO_DIR, f)))[0])
    size_kb = os.path.getsize(test_file) / 1024

    with open(test_file, "rb") as f:
        audio_bytes = f.read()

    resp = requests.post(
        f"{SHIM_URL}/audio/transcriptions",
        files={"file": ("audio.webm", audio_bytes, "audio/webm")},
        data={"language": "en"},
        timeout=120,
    )

    assert resp.status_code == 200, f"Transcription failed: {resp.status_code}"
    data = resp.json()
    assert "text" in data, f"Missing 'text' in response: {data}"
    assert data.get("object") == "transcription", f"Unexpected object: {data}"

    text = data["text"]
    print(f"[OK] Transcribed {size_kb:.0f}KB: '{text[:80]}' (len={len(text)})")
    return True

def main():
    print("=== NPU Whisper Shim Test ===")
    print(f"Shim URL: {SHIM_URL}")
    print()

    tests = [
        ("Health check", test_health),
        ("Transcription", test_transcribe),
    ]

    passed = 0
    for name, fn in tests:
        print(f"--- {name} ---")
        try:
            fn()
            passed += 1
        except Exception as e:
            print(f"[FAIL] {e}")

    print()
    print(f"Results: {passed}/{len(tests)} passed")
    return 0 if passed == len(tests) else 1

if __name__ == "__main__":
    sys.exit(main())
