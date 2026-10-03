"""Compile the production keyboard and exercise UIKit hit testing in a simulator."""

import json
from pathlib import Path
import platform
import subprocess
import tempfile


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    if platform.system() != "Darwin":
        raise SystemExit("Keyboard UIKit tests require macOS, Xcode, and an iOS Simulator.")

    plugin = Path(__file__).resolve().parents[1]
    devices = json.loads(output("xcrun", "simctl", "list", "devices", "available", "--json"))
    iphones = [
        device
        for runtime, runtime_devices in devices["devices"].items()
        if ".iOS-" in runtime
        for device in runtime_devices
        if device["isAvailable"] and device["name"].startswith("iPhone")
    ]
    if not iphones:
        raise SystemExit("No available iPhone Simulator. Install an iOS runtime in Xcode.")

    device = next((item for item in iphones if item["state"] == "Booted"), iphones[-1])
    udid = device["udid"]
    booted_here = device["state"] != "Booted"
    if booted_here:
        subprocess.run(["xcrun", "simctl", "boot", udid], check=True)

    try:
        subprocess.run(["xcrun", "simctl", "bootstatus", udid, "-b"], check=True)
        sdk = output("xcrun", "--sdk", "iphonesimulator", "--show-sdk-path")
        architecture = platform.machine()
        with tempfile.TemporaryDirectory(prefix="keyboard-touch-") as directory:
            source = Path(directory) / "KeyboardTouchTests.swift"
            source.write_text(
                (plugin / "ios/KeyboardViewController.swift").read_text()
                + "\n"
                + (plugin / "tests/KeyboardTouchTests.swift").read_text()
            )
            executable = str(Path(directory) / "keyboard-touch-tests")
            subprocess.run([
                "xcrun", "swiftc", "-swift-version", "5", "-parse-as-library",
                "-sdk", sdk, "-target", f"{architecture}-apple-ios18.0-simulator",
                str(source), "-o", executable,
            ], check=True)
            subprocess.run(["xcrun", "simctl", "spawn", udid, executable], check=True)
    finally:
        if booted_here:
            subprocess.run(["xcrun", "simctl", "shutdown", udid], check=True)


if __name__ == "__main__":
    main()
