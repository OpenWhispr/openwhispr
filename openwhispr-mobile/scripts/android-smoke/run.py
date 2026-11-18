#!/usr/bin/env python3
"""Build/install a disposable instrumentation APK; requires existing normal UI consent."""
import os
import pathlib
import subprocess
import tempfile
import zipfile

source = pathlib.Path(__file__).resolve().parent
mobile = source.parent.parent
sdk = pathlib.Path(os.environ['ANDROID_HOME'])
jdk = pathlib.Path(os.environ['JAVA_HOME'])
build_tools = sdk / 'build-tools' / '36.0.0'
android_jar = sdk / 'platforms' / 'android-36' / 'android.jar'
adb = [str(sdk / 'platform-tools' / 'adb'), '-s', os.environ.get('ANDROID_SERIAL', 'emulator-5554')]


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


with tempfile.TemporaryDirectory(prefix='openwhispr-insertion-') as temporary:
    out = pathlib.Path(temporary)
    classes = out / 'classes'
    classes.mkdir()
    run(jdk / 'bin/javac', '-source', '8', '-target', '8', '-classpath', android_jar,
        '-d', classes, *source.glob('*.java'))
    jar = out / 'test.jar'
    run(jdk / 'bin/jar', 'cf', jar, '-C', classes, '.')
    run(build_tools / 'd8', '--lib', android_jar, '--output', out, jar)
    apk = out / 'test.apk'
    run(build_tools / 'aapt2', 'link', '-o', apk, '-I', android_jar, '--manifest', source / 'AndroidManifest.xml')
    with zipfile.ZipFile(apk, 'a') as bundle:
        bundle.write(out / 'classes.dex', 'classes.dex')
    aligned = out / 'aligned.apk'
    run(build_tools / 'zipalign', '-p', '4', apk, aligned)
    run(build_tools / 'apksigner', 'sign', '--ks', mobile / 'android/app/debug.keystore',
        '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', aligned)
    run(*adb, 'install', '--no-incremental', '-r', aligned)
    result = subprocess.run([*adb, 'shell', 'am', 'instrument', '-w',
        'com.openwhispr.androidtest/.InsertionSmoke'], text=True, capture_output=True, check=True)
    print(result.stdout)
    if 'PASS: 6 real cross-process insertion checks' not in result.stdout:
        raise SystemExit(1)
