"""Compile the production keyboard for Mac Catalyst and exercise its UIKit hit testing."""

import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

# Matches IPHONEOS_DEPLOYMENT_TARGET in withKeyboardExtension.js.
DEPLOYMENT_TARGET = "15.1"


def main():
    if platform.system() != "Darwin":
        raise SystemExit("Keyboard UIKit tests require macOS and Xcode.")

    plugin = Path(__file__).resolve().parents[1]
    # Appended in this order; the second file's tests are called from the first's main.
    tests = [plugin / "tests/KeyboardTouchTests.swift", plugin / "tests/KeyboardTypingUITests.swift"]
    sdk = subprocess.check_output(
        ["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True
    ).strip()
    with tempfile.TemporaryDirectory(prefix="keyboard-touch-") as directory:
        source = Path(directory) / "keyboard-with-touch-tests.swift"
        # A snapshot of the other sources: a file edited mid-compile fails the build.
        snapshot = Path(directory) / "sources"
        snapshot.mkdir()
        # The tests reach the controller's private members, so they share its file. The
        # other keyboard sources compile as files of their own, as in the extension target
        # (a Jest test keeps that target's list equal to ios/*.swift). #sourceLocation keeps
        # compiler errors and traps pointing at the real files.
        controller = plugin / "ios/KeyboardViewController.swift"
        others = sorted(set((plugin / "ios").glob("*.swift")) - {controller})
        others = [Path(shutil.copy2(path, snapshot / path.name)) for path in others]

        def located(path):
            return f"#sourceLocation(file: {json.dumps(str(path), ensure_ascii=False)}, line: 1)\n"

        source.write_text(
            located(controller) + controller.read_text()
            + "".join("\n" + located(path) + path.read_text() for path in tests)
        )
        executable = str(Path(directory) / "keyboard-touch-tests")
        subprocess.run([
            "xcrun", "--sdk", "macosx", "swiftc", "-swift-version", "5", "-parse-as-library",
            "-sdk", sdk,
            "-target", f"{platform.machine()}-apple-ios{DEPLOYMENT_TARGET}-macabi",
            "-Fsystem", f"{sdk}/System/iOSSupport/System/Library/Frameworks",
            str(source), *map(str, others), "-o", executable,
        ], check=True)
        # Arguments pass through: `--screenshots <directory>` renders the review PNGs.
        subprocess.run([executable, *sys.argv[1:]], check=True)


if __name__ == "__main__":
    main()
