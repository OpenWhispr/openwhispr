"""Exercise the production uploader's background relaunch path without React Native."""

import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile


def main() -> None:
    if platform.system() != "Darwin":
        raise SystemExit("Background recovery tests require macOS and Xcode.")

    tests = Path(__file__).resolve().parent
    module = tests.parent
    sdk = subprocess.check_output(
        ["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True
    ).strip()
    with tempfile.TemporaryDirectory(prefix="background-recovery-") as directory:
        output = Path(directory)
        compiler = [
            "xcrun", "--sdk", "macosx", "swiftc", "-swift-version", "5",
            "-sdk", sdk, "-target", f"{platform.machine()}-apple-ios15.1-macabi",
            "-Fsystem", f"{sdk}/System/iOSSupport/System/Library/Frameworks",
            "-module-cache-path", str(output / "module-cache"),
        ]
        subprocess.run([
            *compiler, "-emit-library", "-emit-module", "-module-name", "ExpoModulesCore",
            str(tests / "ExpoModulesCoreStub.swift"),
            "-emit-module-path", str(output / "ExpoModulesCore.swiftmodule"),
            "-o", str(output / "libExpoModulesCore.dylib"),
        ], check=True)

        # As in the keyboard UIKit tests, append tests so private implementation
        # details remain private in production. No uploader source is rewritten.
        source = output / "BackgroundUploaderWithTests.swift"
        uploader = module / "ios/BackgroundUploaderModule.swift"
        callback = module / "plugin/BackgroundUploadAppDelegate.swift"
        regression = tests / "BackgroundUploadRecoveryTests.swift"

        def located(path: Path) -> str:
            return f"#sourceLocation(file: {json.dumps(str(path))}, line: 1)\n{path.read_text()}\n"

        source.write_text(
            located(uploader)
            + "\nclass AppDelegate: ExpoAppDelegate {\n"
            + located(callback)
            + "}\n"
            + located(regression)
        )
        executable = output / "background-recovery-tests"
        subprocess.run([
            *compiler, "-parse-as-library", "-I", str(output), "-L", str(output),
            "-lExpoModulesCore", "-Xlinker", "-rpath", "-Xlinker", str(output),
            str(source),
            str(module / "ios/ProviderRequestTransport.swift"),
            str(module / "ios/ProviderJobMetadata.swift"),
            str(module / "ios/ProviderRecoveryStore.swift"),
            "-o", str(executable),
        ], check=True)
        # Each ordering starts with fresh process-wide session state.
        for scenario in ("background-first", "foreground-first"):
            subprocess.run([str(executable), scenario], check=True, timeout=30, env={
                **os.environ, "BACKGROUND_RECOVERY_TEST_ID": output.name,
            })


if __name__ == "__main__":
    main()
