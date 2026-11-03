#!/usr/bin/env python3
"""Build Sherpa and Moonshine against one ORT; never package upstream JNI binaries."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

VERSION = "1.13.8"
ORT_VERSION = "1.28.2"
MOONSHINE_COMMIT = "234f60faa0eb388b01cdf7e60aca232af37aefda"
DOWNLOADS = {
    "moonshine-source.tar.gz": (
        f"https://codeload.github.com/moonshine-ai/moonshine/tar.gz/{MOONSHINE_COMMIT}",
        "6bd927a48234dced3cc6f208522fe176c248686e9283273c51eddc8d7994e001",
    ),
    "moonshine.aar": (
        "https://repo.maven.apache.org/maven2/ai/moonshine/moonshine-voice/0.1.5/moonshine-voice-0.1.5.aar",
        "ee2d95c21150683c743db8f3aef66281fd5408bcefc94be3ca1d2545ada1f571",
    ),
    "source.tar.gz": (
        f"https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v{VERSION}.tar.gz",
        "b0374cc56dbc186d442ae73d5de743bb092470b640c4c50ce7b029044c0c4fa8",
    ),
    "bindings.aar": (
        f"https://github.com/k2-fsa/sherpa-onnx/releases/download/v{VERSION}/sherpa-onnx-{VERSION}.aar",
        "633c24321e06b1fe79feafa03ea16cbc0f8a286641e2da3559bac91bdb13bd96",
    ),
    "onnxruntime.zip": (
        f"https://github.com/csukuangfj/onnxruntime-libs/releases/download/v{ORT_VERSION}/onnxruntime-android-{ORT_VERSION}.zip",
        "01518867f78241138b6aa25925802e843a4fa9085af8d303d49e35bbb52aff4d",
    ),
}


def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def download(cache, filename):
    url, expected = DOWNLOADS[filename]
    path = cache / filename
    if not path.exists():
        temporary = path.with_suffix(".download")
        run("curl", "--fail", "--location", "--retry", "3", "--output", temporary, url)
        temporary.replace(path)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != expected:
        raise RuntimeError(f"Checksum mismatch: {path}. Remove it and retry.")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", required=True, type=Path)
    parser.add_argument("--ndk", required=True, type=Path)
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--abis", default="arm64-v8a")
    args = parser.parse_args()
    abis = args.abis.split(",")
    if not set(abis) <= {"arm64-v8a", "armeabi-v7a", "x86_64", "x86"}:
        parser.error("Unsupported Android ABI")
    cmake = args.sdk / "cmake/3.22.1/bin/cmake"
    ninja = cmake.with_name("ninja")
    toolchain = args.ndk / "build/cmake/android.toolchain.cmake"
    if not cmake.exists() or not toolchain.exists():
        parser.error("Install CMake 3.22.1 and the project NDK through Android SDK Manager")
    cache = args.cache / VERSION
    cache.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    archives = {name: download(cache, name) for name in DOWNLOADS}
    source = cache / "source"
    if not source.exists():
        temporary = cache / "source-extract"
        temporary.mkdir(exist_ok=True)
        run("tar", "-xzf", archives["source.tar.gz"], "--strip-components=1", "-C", temporary)
        temporary.rename(source)
    ort = cache / "onnxruntime"
    # Only Kotlin bindings are taken from the AAR. Its TTS-enabled JNI is excluded.
    with zipfile.ZipFile(archives["bindings.aar"]) as archive:
        (args.output / "classes.jar").write_bytes(archive.read("classes.jar"))
    with zipfile.ZipFile(archives["moonshine.aar"]) as archive:
        (args.output / "moonshine.jar").write_bytes(archive.read("classes.jar"))
    moonshine = cache / f"moonshine-{MOONSHINE_COMMIT}"
    if not moonshine.exists():
        temporary = cache / "moonshine-extract"
        temporary.mkdir(exist_ok=True)
        run("tar", "-xzf", archives["moonshine-source.tar.gz"], "--strip-components=1",
            "--exclude=*/core/third-party/onnxruntime/lib/*", "-C", temporary)
        temporary.rename(moonshine)
    with zipfile.ZipFile(archives["onnxruntime.zip"]) as archive:
        for info in archive.infolist():
            if info.filename.startswith("headers/") or any(
                info.filename == f"jni/{abi}/libonnxruntime.so" for abi in abis
            ):
                archive.extract(info, ort)
    for abi in abis:
        build = cache / f"build-meetings-{abi}"
        env = {
            **os.environ,
            "SHERPA_ONNXRUNTIME_LIB_DIR": str(ort / "jni" / abi),
            "SHERPA_ONNXRUNTIME_INCLUDE_DIR": str(ort / "headers"),
        }
        run(cmake, "-S", source, "-B", build, "-G", "Ninja",
            f"-DCMAKE_MAKE_PROGRAM={ninja}", f"-DCMAKE_TOOLCHAIN_FILE={toolchain}",
            f"-DANDROID_ABI={abi}", "-DANDROID_PLATFORM=android-24",
            "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON", "-DCMAKE_BUILD_TYPE=Release",
            "-DBUILD_SHARED_LIBS=ON", "-DSHERPA_ONNX_ENABLE_JNI=ON",
            "-DSHERPA_ONNX_ENABLE_TTS=OFF", "-DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=ON",
            "-DSHERPA_ONNX_ENABLE_C_API=OFF", "-DSHERPA_ONNX_ENABLE_BINARY=OFF",
            "-DSHERPA_ONNX_ENABLE_PYTHON=OFF", "-DSHERPA_ONNX_ENABLE_TESTS=OFF",
            "-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF", "-DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF",
            "-DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF", env=env)
        run(cmake, "--build", build, "--target", "sherpa-onnx-jni", "--parallel", "4", env=env)
        library = build / "lib/libsherpa-onnx-jni.so"
        data = library.read_bytes()
        if any(marker in data for marker in (b"espeak_ng", b"espeak-ng-data", b"PiperPhonemes")):
            raise RuntimeError("Speech runtime unexpectedly contains speech-synthesis code")
        destination = args.output / "jni" / abi
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copy2(library, destination)
        shutil.copy2(ort / "jni" / abi / "libonnxruntime.so", destination)
        # Upstream CMake assigns this path internally. Rebuild instead of mixing
        # the AAR's ORT 1.23.2 imports with Sherpa's ORT 1.28.2 exports.
        moonshine_abi = "arm64" if abi == "arm64-v8a" else abi
        moonshine_ort = moonshine / "core/third-party/onnxruntime/lib/android" / moonshine_abi
        moonshine_ort.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ort / "jni" / abi / "libonnxruntime.so", moonshine_ort)
        moonshine_build = cache / f"moonshine-build-{MOONSHINE_COMMIT}-{abi}"
        run(cmake, "-S", moonshine / "core", "-B", moonshine_build, "-G", "Ninja",
            f"-DCMAKE_MAKE_PROGRAM={ninja}", f"-DCMAKE_TOOLCHAIN_FILE={toolchain}",
            f"-DANDROID_ABI={abi}", "-DANDROID_PLATFORM=android-26", "-DANDROID_STL=c++_shared",
            "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON", "-DCMAKE_BUILD_TYPE=Release")
        run(cmake, "--build", moonshine_build, "--target", "moonshine-jni", "--parallel", "4")
        shutil.copy2(moonshine_build / "libmoonshine.so", destination)
        shutil.copy2(moonshine_build / "moonshine-jni/libmoonshine-jni.so", destination)
    print(f"Sherpa {VERSION} and Moonshine 0.1.5 ready for {', '.join(abis)}")


if __name__ == "__main__":
    main()
