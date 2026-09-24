#!/usr/bin/env python3
"""Compile the real OrukeetInstaller actor against a controlled SDK boundary."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--mutation-check", action="store_true")
    args = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("Requires macOS and the Swift compiler")
    mobile = Path(__file__).resolve().parent.parent
    source = mobile / "modules/parakeet-asr/ios/OrukeetInstaller.swift"
    fixtures = mobile / "scripts/orukeet-installer-regression"
    with tempfile.TemporaryDirectory(prefix="orukeet-installer-") as temporary:
        root = Path(temporary)
        subprocess.run(["xcrun", "swiftc", "-swift-version", "6", "-emit-library", "-emit-module",
                        "-module-name", "OrukeetCoreML", str(fixtures / "StubSDK.swift"),
                        "-emit-module-path", str(root / "OrukeetCoreML.swiftmodule"),
                        "-o", str(root / "libOrukeetCoreML.dylib")], check=True)

        def run(wrapper):
            binary = root / "check"
            subprocess.run(["xcrun", "swiftc", "-swift-version", "6", "-parse-as-library",
                            "-I", str(root), "-L", str(root), "-lOrukeetCoreML",
                            "-Xlinker", "-rpath", "-Xlinker", str(root), str(wrapper),
                            str(fixtures / "Main.swift"), "-o", str(binary)], check=True)
            return subprocess.run([str(binary)], text=True, capture_output=True, timeout=30,
                                  env={**os.environ, "ORUKEET_INSTALLER_REGRESSION_ROOT": str(root / "fixtures")})

        completed = run(source)
        if completed.returncode:
            raise RuntimeError(completed.stdout + completed.stderr)
        report = json.loads(completed.stdout)
        report["source_sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
        if args.mutation_check:
            mutated = root / "MutatedInstaller.swift"
            text = source.read_text()
            marker = "guard running == nil, deleting == nil else"
            if marker not in text:
                raise AssertionError("Admission-guard mutation no longer matches source")
            mutated.write_text(text.replace(marker, "guard deleting == nil else"))
            try:
                result = run(mutated)
                caught = result.returncode != 0
            except subprocess.TimeoutExpired:
                caught = True
            if not caught:
                raise AssertionError("Missing recovery-admission guard survived regression")
            existence_guard = "FileManager.default.fileExists(atPath: installed.path) else { return nil }"
            if existence_guard not in text:
                raise AssertionError("Recovery-result mutation no longer matches source")
            mutated.write_text(text.replace(existence_guard, "true else { return nil }"))
            if run(mutated).returncode == 0:
                raise AssertionError("Missing recovery-result existence check survived regression")
            report["mutation_check"] = ["removing recovery admission guards is rejected",
                                        "removing the recovery-result existence check is rejected"]
    output = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output)
    print(output, end="")


if __name__ == "__main__":
    main()
