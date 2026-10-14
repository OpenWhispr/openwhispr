"""Compile the production keyboard for Mac Catalyst and exercise its UIKit hit testing."""

import json
from pathlib import Path
import platform
import subprocess
import tempfile

# Matches IPHONEOS_DEPLOYMENT_TARGET in withKeyboardExtension.js.
DEPLOYMENT_TARGET = "15.1"


def main():
    if platform.system() != "Darwin":
        raise SystemExit("Keyboard UIKit tests require macOS and Xcode.")

    plugin = Path(__file__).resolve().parents[1]
    tests = plugin / "tests/KeyboardTouchTests.swift"
    sdk = subprocess.check_output(
        ["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True
    ).strip()
    with tempfile.TemporaryDirectory(prefix="keyboard-touch-") as directory:
        source = Path(directory) / "keyboard-with-touch-tests.swift"
        # #sourceLocation keeps compiler errors and traps pointing at the test file.
        source.write_text(
            (plugin / "ios/KeyboardViewController.swift").read_text()
            + f"\n#sourceLocation(file: {json.dumps(str(tests), ensure_ascii=False)}, line: 1)\n"
            + tests.read_text()
        )
        executable = str(Path(directory) / "keyboard-touch-tests")
        subprocess.run([
            "xcrun", "--sdk", "macosx", "swiftc", "-swift-version", "5", "-parse-as-library",
            "-sdk", sdk,
            "-target", f"{platform.machine()}-apple-ios{DEPLOYMENT_TARGET}-macabi",
            "-Fsystem", f"{sdk}/System/iOSSupport/System/Library/Frameworks",
            str(source), "-o", executable,
        ], check=True)
        subprocess.run([executable], check=True)


if __name__ == "__main__":
    main()
