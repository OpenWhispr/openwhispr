"""Builds the keyboard and its tests as a small app, runs it in an iOS simulator, prints the result.

    python3 tests/run-keyboard-sim-harness.py <simulator udid> [--perf] [--tests]
        [--screenshots <dir> --device <se|promax>]
        [--host-field <text> [--dark] [--number-pad] --capture <png>]

The app holds the production keyboard sources in a real window on a real iOS: the typing UI
checks, true light and dark screenshots, and the latency and memory figures (-O build). The
simulator shares the Mac's file system, so the app reads the lexicons from this folder and
writes its results to a temporary folder here.
"""

import json
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time

DEPLOYMENT_TARGET = "17.0"
BUNDLE_ID = "com.gizmolabs.openwhispr.keyboardharness"


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    udid, arguments = sys.argv[1], sys.argv[2:]
    plugin = Path(__file__).resolve().parents[1]
    sdk = subprocess.check_output(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"], text=True).strip()
    controller = plugin / "ios/KeyboardViewController.swift"
    tests = [plugin / f"tests/{name}.swift" for name in ("KeyboardTouchTests", "KeyboardTypingUITests", "KeyboardSimHarness")]
    others = sorted(set((plugin / "ios").glob("*.swift")) - {controller})

    def located(path):
        return f"#sourceLocation(file: {json.dumps(str(path), ensure_ascii=False)}, line: 1)\n"

    with tempfile.TemporaryDirectory(prefix="keyboard-sim-") as directory:
        directory = Path(directory)
        # A snapshot of the other sources: a file edited mid-compile fails the build.
        snapshot = directory / "sources"
        snapshot.mkdir()
        others = [Path(shutil.copy2(path, snapshot / path.name)) for path in others]
        source = directory / "keyboard-with-tests.swift"
        source.write_text(
            located(controller) + controller.read_text()
            + "".join("\n" + located(path) + path.read_text() for path in tests)
        )
        app = directory / "KeyboardHarness.app"
        app.mkdir()
        subprocess.run([
            "xcrun", "--sdk", "iphonesimulator", "swiftc", "-swift-version", "5", "-parse-as-library", "-O",
            "-sdk", sdk, "-target", f"{platform.machine()}-apple-ios{DEPLOYMENT_TARGET}-simulator",
            str(source), *map(str, others), "-o", str(app / "KeyboardHarness"),
        ], check=True)
        with open(app / "Info.plist", "wb") as handle:
            plistlib.dump({
                "CFBundleIdentifier": BUNDLE_ID,
                "CFBundleExecutable": "KeyboardHarness",
                "CFBundleName": "KeyboardHarness",
                "CFBundlePackageType": "APPL",
                "CFBundleVersion": "1",
                "CFBundleShortVersionString": "1.0",
                "MinimumOSVersion": DEPLOYMENT_TARGET,
                "LSRequiresIPhoneOS": True,
                "UIDeviceFamily": [1],
                "UILaunchScreen": {},
                "CFBundleSupportedPlatforms": ["iPhoneSimulator"],
                "NSMicrophoneUsageDescription": "The harness starts the keyboard's dictation capture to measure memory.",
            }, handle)
        subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True, capture_output=True)
        subprocess.run(["xcrun", "simctl", "install", udid, str(app)], check=True)
        output = directory / "out"
        output.mkdir()
        subprocess.run(
            ["xcrun", "simctl", "launch", "--terminate-running-process", udid, BUNDLE_ID, "--output", str(output), *arguments],
            check=True, capture_output=True,
        )
        if "--capture" in sys.argv:
            # With --host-field: a screenshot of the simulator once the keyboard is up.
            time.sleep(7)
            subprocess.run(
                ["xcrun", "simctl", "io", udid, "screenshot", sys.argv[sys.argv.index("--capture") + 1]],
                check=True, capture_output=True,
            )
        deadline = time.time() + 480
        while not (output / "done").exists():
            if time.time() > deadline:
                progress = output / "progress.txt"
                print(progress.read_text() if progress.exists() else "(no progress written)")
                raise SystemExit("The harness app did not finish in time.")
            time.sleep(1)
        result = (output / "result.txt").read_text()
        print(result)
        subprocess.run(["xcrun", "simctl", "uninstall", udid, BUNDLE_ID], check=False, capture_output=True)
        if "FAIL:" in result:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
