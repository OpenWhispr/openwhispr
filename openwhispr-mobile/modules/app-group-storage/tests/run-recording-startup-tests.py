"""Compile and run the Foundation-only recording startup gate tests."""
from pathlib import Path
import subprocess
import tempfile


def main():
    module = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="recording-startup-") as output:
        executable = str(Path(output) / "tests")
        subprocess.run([
            "swiftc", "-swift-version", "5", "-o", executable,
            str(module / "ios/KeyboardRecordingStartupGate.swift"),
            str(module / "tests/KeyboardRecordingStartupGateTests.swift"),
        ], check=True)
        subprocess.run([executable], check=True)


if __name__ == "__main__":
    main()
