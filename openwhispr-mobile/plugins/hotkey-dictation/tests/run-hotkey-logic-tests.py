"""Compile and run the hotkey dictation decision tests (Foundation only, no simulator)."""
from pathlib import Path
import subprocess
import tempfile


def main():
    plugin = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="hotkey-logic-") as output:
        executable = str(Path(output) / "tests")
        subprocess.run([
            "swiftc", "-swift-version", "5", "-o", executable,
            str(plugin / "ios/HotkeyDictationLogic.swift"),
            str(plugin / "tests/HotkeyDictationLogicTests.swift"),
        ], check=True)
        subprocess.run([executable], check=True)


if __name__ == "__main__":
    main()
