"""Characterize the Expo presenter against the pinned Superwall lifecycle tracker.

Android and Expo are lightweight host stubs. This does not run a native paywall.
"""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request

MOBILE = Path(__file__).resolve().parents[2]
SDK_VERSION = "2.8.3"
SDK_HASHES = {
    "ActivityProvider.kt": "9af45bd195ae89eea0f5c9385ea58c18e3a1062500d7532c9be3464a92a742cb",
    "CurrentActivityTracker.kt": "5407187a037db82f3afa2b59876dc1a8183618b5290e52d256837c618a75be33",
}
STUBS = {
    'Activity.kt': """package android.app
open class Activity(val label: String)
""",
    'Application.kt': """package android.app
import android.content.Context
import android.os.Bundle
class Application : Context() {
  val callbacks = mutableListOf<ActivityLifecycleCallbacks>()
  fun registerActivityLifecycleCallbacks(callback: ActivityLifecycleCallbacks) { callbacks.add(callback) }
  interface ActivityLifecycleCallbacks {
    fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?)
    fun onActivityStarted(activity: Activity)
    fun onActivityResumed(activity: Activity)
    fun onActivityPaused(activity: Activity)
    fun onActivityStopped(activity: Activity)
    fun onActivitySaveInstanceState(activity: Activity, outState: Bundle)
    fun onActivityDestroyed(activity: Activity)
  }
}
""",
    'Context.kt': """package android.content
open class Context { open val applicationContext: Context get() = this }
""",
    'Bundle.kt': """package android.os
class Bundle
""",
    'AppContext.kt': """package expo.modules.kotlin
import android.app.Activity
import android.content.Context
class AppContext(var currentActivity: Activity?, val reactContext: Context?)
""",
    'Logger.kt': """package com.superwall.sdk.logger
enum class LogLevel { debug }
enum class LogScope { all }
object Logger { @Suppress("UNUSED_PARAMETER") fun debug(level: LogLevel, scope: LogScope, message: String) {} }
""",
}


def cached_jar(cache, group, artifact, version):
    matches = list((cache / group / artifact / version).glob(f"*/{artifact}-{version}.jar"))
    if len(matches) != 1:
        raise RuntimeError(f"Expected one cached {artifact}:{version} JAR, found {len(matches)}")
    return str(matches[0])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    provider_path = (MOBILE / "node_modules/expo-superwall/android/src/main/java"
                     / "expo/modules/superwallexpo/ReactNativeActivityProvider.kt")
    parser.add_argument("--provider", type=Path, default=provider_path)
    parser.add_argument("--sdk-source-dir", type=Path, help="Optional offline directory with the two pinned SDK source files")
    args = parser.parse_args()
    if not args.provider.is_file():
        parser.error(f"Provider source does not exist: {args.provider}")
    java_home = os.environ.get("JAVA_HOME")
    java = str(Path(java_home) / "bin/java") if java_home else shutil.which("java")
    if not java:
        parser.error("Set JAVA_HOME to a JDK 17 or newer")
    cache = Path(os.environ.get("GRADLE_USER_HOME", Path.home() / ".gradle")) / "caches/modules-2/files-2.1"
    dependencies = [
        ("org.jetbrains.kotlin", "kotlin-compiler-embeddable", "2.1.20"),
        ("org.jetbrains.kotlin", "kotlin-stdlib", "2.1.20"),
        ("org.jetbrains.kotlin", "kotlin-script-runtime", "2.1.20"),
        ("org.jetbrains.kotlin", "kotlin-reflect", "2.1.20"),
        ("org.jetbrains.intellij.deps", "trove4j", "1.0.20200330"),
        ("org.jetbrains", "annotations", "23.0.0"),
        ("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"),
    ]
    jars = [cached_jar(cache, *dependency) for dependency in dependencies]
    with tempfile.TemporaryDirectory(prefix="superwall-activity-probe-") as temporary:
        root = Path(temporary)
        for name, source in STUBS.items():
            (root / name).write_text(source)
        for name, expected_hash in SDK_HASHES.items():
            if args.sdk_source_dir:
                source = (args.sdk_source_dir / name).read_bytes()
            else:
                url = (f"https://raw.githubusercontent.com/superwall/Superwall-Android/{SDK_VERSION}/"
                       f"superwall/src/main/java/com/superwall/sdk/misc/{name}")
                with urllib.request.urlopen(url, timeout=20) as response:
                    source = response.read()
            if hashlib.sha256(source).hexdigest() != expected_hash:
                raise RuntimeError(f"Pinned SDK source checksum mismatch: {name}")
            (root / name).write_bytes(source)
        sources = sorted(str(path) for path in root.glob("*.kt"))
        sources += [str(args.provider.resolve()), str(Path(__file__).with_name("ActivityProviderProbe.kt"))]
        classes = root / "classes"
        classes.mkdir()
        subprocess.run([
            java, "-cp", os.pathsep.join(jars), "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
            "-no-stdlib", "-no-reflect", "-jvm-target", "17",
            "-classpath", os.pathsep.join(jars[1:]), "-d", str(classes), *sources,
        ], check=True, timeout=90)
        subprocess.run([
            java, "-cp", os.pathsep.join([str(classes), *jars[1:]]), "ActivityProviderProbeKt",
        ], check=True, timeout=30)


if __name__ == "__main__":
    main()
