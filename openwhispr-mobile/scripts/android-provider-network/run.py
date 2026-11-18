#!/usr/bin/env python3
"""Exercise the compiled provider transport with the generated release network policy.

Requires a running emulator, Node 24, JAVA_HOME (17) and ANDROID_HOME (SDK 36).
Installs and removes only a self-targeted disposable fixture, not OpenWhispr.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile
from xml.sax.saxutils import quoteattr

source = Path(__file__).resolve().parent
mobile = source.parent.parent
sdk = Path(os.environ['ANDROID_HOME'])
jdk = Path(os.environ['JAVA_HOME'])
build_tools = sdk / 'build-tools/36.0.0'
android_jar = sdk / 'platforms/android-36/android.jar'
cache = Path(os.environ.get('GRADLE_USER_HOME', Path.home() / '.gradle')) / 'caches/modules-2/files-2.1'
package = 'com.openwhispr.providernetworktest'
serial = os.environ.get('ANDROID_SERIAL', 'emulator-5554')
if not serial.startswith('emulator-'):
    raise SystemExit('Run this disposable fixture on an emulator.')
adb = [sdk / 'platform-tools/adb', '-s', serial]


def run(*args, cwd=mobile):
    result = subprocess.run(list(map(str, args)), cwd=cwd, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout or f'Command failed: {args[0]}')
    return result.stdout


def jar(directory):
    matches = list(directory.glob('*/*.jar'))
    if len(matches) != 1:
        raise RuntimeError(f'Expected one cached dependency under {directory}')
    return matches[0]


if run(*adb, 'shell', 'pm', 'list', 'packages', package).strip():
    raise SystemExit('Fixture package already exists; inspect its ownership before removing it.')

# Introspection runs the real registered Expo plugins, including production mods.
# Retain only the network attributes; never write the full config or credentials.
config = json.loads(run('node', 'node_modules/expo/bin/cli', 'config', '--type', 'introspect', '--json'))
app = config['_internal']['modResults']['android']['manifest']['manifest']['application'][0]['$']
if 'android:networkSecurityConfig' in app:
    raise SystemExit('Network security XML now exists; extend this fixture to package that resource.')
attribute = app.get('android:usesCleartextTraffic')
network_attribute = '' if attribute is None else ' android:usesCleartextTraffic=' + quoteattr(str(attribute))

run('./gradlew', ':android-dictation:bundleLibCompileToJarDebug',
    '-PreactNativeArchitectures=arm64-v8a', '--max-workers=4', cwd=mobile / 'android')
native_jar = mobile / 'modules/android-dictation/android/build/intermediates/compile_library_classes_jar/debug/bundleLibCompileToJarDebug/classes.jar'
expo_jar = mobile / 'node_modules/expo-modules-core/android/build/intermediates/compile_library_classes_jar/debug/bundleLibCompileToJarDebug/classes.jar'
jars = [jar(cache / dependency) for dependency in [
    'com.squareup.okhttp3/okhttp/4.12.0',
    'com.squareup.okio/okio-jvm/3.6.0',
    'org.jetbrains.kotlin/kotlin-stdlib/2.1.20',
]]

with tempfile.TemporaryDirectory(prefix='ow-provider-network-') as temporary:
    out = Path(temporary)
    classes = out / 'classes'
    classes.mkdir()
    # Extract the real compiled transport and error classes, not test substitutes.
    with zipfile.ZipFile(out / 'runtime.jar', 'w') as runtime:
        for library, prefixes in [(native_jar, ('com/openwhispr/dictation/ProviderTransport',)),
                                  (expo_jar, ('expo/modules/kotlin/exception/CodedException',
                                              'expo/modules/core/interfaces/DoNotStrip'))]:
            with zipfile.ZipFile(library) as contents:
                for name in contents.namelist():
                    if name.endswith('.class') and name.startswith(prefixes):
                        runtime.writestr(name, contents.read(name))
    jars.append(out / 'runtime.jar')
    run(jdk / 'bin/javac', '-source', '8', '-target', '8', '-classpath',
        os.pathsep.join(map(str, [android_jar, *jars])), '-d', classes, source / 'ProviderNetworkProbe.java')
    run(jdk / 'bin/jar', 'cf', out / 'fixture.jar', '-C', classes, '.')
    run(build_tools / 'd8', '--min-api', '24', '--lib', android_jar, '--output', out, out / 'fixture.jar', *jars)
    manifest = out / 'AndroidManifest.xml'
    manifest.write_text(f'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{package}">'
                        '<uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/>'
                        '<uses-permission android:name="android.permission.INTERNET"/>'
                        f'<application android:label="Provider network test"{network_attribute}/>'
                        f'<instrumentation android:name=".ProviderNetworkProbe" android:targetPackage="{package}"/>'
                        '</manifest>')
    apk, signed = out / 'fixture.apk', out / 'signed.apk'
    run(build_tools / 'aapt2', 'link', '-o', apk, '-I', android_jar, '--manifest', manifest)
    with zipfile.ZipFile(apk, 'a') as bundle:
        for dex in out.glob('classes*.dex'):
            bundle.write(dex, dex.name)
    run(build_tools / 'zipalign', '-p', '4', apk, signed)
    run(build_tools / 'apksigner', 'sign', '--ks', mobile / 'android/app/debug.keystore',
        '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', signed)
    try:
        run(*adb, 'install', '--no-incremental', signed)
        result = run(*adb, 'shell', 'am', 'instrument', '-w', package + '/.ProviderNetworkProbe')
        print(result)
        if 'PASS: private HTTP' not in result:
            raise SystemExit(1)
    finally:
        print('Fixture cleanup:', run(*adb, 'uninstall', package).strip())
