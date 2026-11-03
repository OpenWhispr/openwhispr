# Moonshine Android integration evidence — 2026-10-15

The initial research and temporary native build below led to the integration and verified emulator inference recorded under Implementation checkpoint and Emulator evidence. Early statements of unverified inference describe that initial research stage. Parakeet remains the default and Qwen remains the cleanup baseline. The dated checkpoints distinguish hosted distribution, installed downloads and native test evidence from physical-phone acceptance.

## Final-word regression and installed distribution — 2026-10-21

Play-installed code18 (`30ac168362392a50d9e5beb7d118fbe3f0f6bd80`) downloaded Tiny from the owned Blob host; Small reached Ready after canceling and retrying its download. Both ran speech and Qwen cleanup in the built-in test. This verifies fresh/retried delivery and inference, not byte-range resume, restart recovery or corrupt-file repair. No physical phone was used.

The original synthetic 4.51675-second clip reproduced the historical tail errors: Tiny returned “to my email” and Small “to my” instead of “tomorrow”. Adding two seconds of silence corrected Tiny, motivating a native investigation. The pinned Java binding runs intermediate updates from `addAudio()` and a forced update from `stop()`. In the pinned native `transcribe_stream`, a stopped stream with no new audio only marks its cached transcript complete; it does not flush the final streaming encoder frames. An intermediate update consuming the final block can therefore leave unfinished text at stop.

`MoonshineEngine` now defers the intermediate update for the final PCM block by setting the Java update interval to positive infinity immediately before adding that block. `stop()` then consumes it as a completed segment. Earlier blocks still stream, memory remains bounded to one-second input blocks, no silence is appended, and reported duration is unchanged. A fresh transcriber per recording resets the interval along with the existing line state.

Two real Android regression tests, one per model, failed before this change with the exact installed errors and passed afterward with “meeting notes tomorrow”. They enforce the unpadded fixture's SHA-256 (`a4d2467bf3207a02ecdb6e2d6968022c95ef415f95c0ed638fed63f437c411c7`) and 4.51675-second duration. The Parakeet → Tiny → Small → Tiny coexistence test also passes with `expectedWords=fox,dog,meeting,notes,tomorrow`; all 16 native unit tests pass. All 16 native model files matched the published manifest. Evidence is retained as `v131-native-red-test.log`, `v131-native-green-test.log`, `v131-native-transcripts.log` and `v131-native-model-verification.json` in the research folder below.

This corrects the adapter's finalization for the reproduced sample; it does not establish general recognition quality or phone performance. The fix is tested in the isolated `com.openwhispr.dictation.test` APK, not yet in a signed Play candidate. Code18 remains unchanged, and its UI selection was restored to Parakeet. Long recordings, physical spoken input, broader accuracy and the remaining download-recovery cases stay open.

## Production distribution checkpoint — 2026-10-20

The OpenWhispr-owned public Vercel Blob store `ow-android-models` now serves the pinned English Tiny and Small files. The [published manifest](https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/manifest.json) records all 16 file sizes and SHA-256 checksums; the same immutable prefix includes the publisher's LICENSE. Anonymous full downloads matched every checksum and size, all 16 tail-range requests returned correct HTTP 206 responses, and cache headers specify one year.

The source URLs now use that store. File names, hashes, sizes, English/API constraints, model selection and Parakeet's default are unchanged. No publishing credential is required or included in the client. Code17 was submitted from `9658d9b33d222f4c598b928aa844a71bd2099933` before this change and still uses the archival mirror. This source change does not alter that build and is not installed-app acceptance.

Remaining acceptance on an eventual consolidated candidate: fresh Tiny/Small downloads, cancellation/resume, restart, same-size corruption repair, selection and actual inference using this host. HTTP range verification alone does not prove that the installed downloader resumes correctly. Keep the immutable objects available to existing clients; use a new prefix for future model revisions. Physical-phone performance and the recorded speech-quality limitations remain open.

## Pinned artifacts

- Upstream source: `234f60faa0eb388b01cdf7e60aca232af37aefda` (v0.1.5), [source archive](https://codeload.github.com/moonshine-ai/moonshine/tar.gz/234f60faa0eb388b01cdf7e60aca232af37aefda), 176,944,864 bytes, SHA-256 `6bd927a48234dced3cc6f208522fe176c248686e9283273c51eddc8d7994e001`.
- Maven [moonshine-voice 0.1.5 AAR](https://repo.maven.apache.org/maven2/ai/moonshine/moonshine-voice/0.1.5/moonshine-voice-0.1.5.aar), SHA-256 `ee2d95c21150683c743db8f3aef66281fd5408bcefc94be3ca1d2545ada1f571`.
- Publisher's [Hugging Face archive documentation](https://github.com/moonshine-ai/moonshine/blob/v0.1.5/docs/models/huggingface.md) identifies `moonshine-ai/moonshine-voice-assets`. Release snapshot `0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae` is immutable. Exact model path: `model/{tiny,small}-streaming-en/quantized_26_08_21/{filename}`.
- Required eight files: `adapter.ort`, `cross_kv.ort`, `decoder_kv.ort`, `encoder.ort`, `frontend.model.ort`, `frontend.weights.ort`, `streaming_config.json`, `tokenizer.bin`. English Tiny totals 45,233,659 bytes; English Small 142,300,974. Optional word-timestamp decoder is excluded; do not imply word-level timestamps.
- Source/config GET returned 200; tokenizer.bin full download (249,974 bytes) SHA-256 matched upstream LFS metadata; Tiny decoder range request returned 206. Full checkpoint download/inference remains unverified. Exact per-file URLs/sizes/SHA-256 are retained in the research locator below; production delivery must choose a maintained endpoint deliberately, since upstream describes HF as an archive/verification source.

## Native compatibility and verified build recipe

The published AAR bundles ORT 1.23.2; its Moonshine native imports require `OrtGetApiBase@VERS_1.23.2`. Sherpa in this app uses ORT 1.28.2, exporting `VERS_1.28.2`. `pickFirst` cannot make these published binaries compatible.

A temporary build from pinned source succeeded using the existing NDK 27.1.12297006, CMake 3.22.1, Android API 26, `c++_shared`, and flexible 16 KB page sizes:

1. Retain `core/**`, `language-bindings/android/moonshine-jni/**` and licenses. Exclude upstream ORT binaries from extraction.
2. Copy the app's verified ORT 1.28.2 binary into `core/third-party/onnxruntime/lib/android/<abi>/libonnxruntime.so`; upstream maps `arm64-v8a` to `arm64`. Other ABI names are unchanged. Upstream's CMake overwrites `ONNXRUNTIME_LIB_PATH` internally, so a command-line override alone is insufficient.
3. Configure `cmake -S <source>/core -B <build> -G Ninja` with the Android toolchain and `-DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-26 -DANDROID_STL=c++_shared -DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON -DCMAKE_BUILD_TYPE=Release`.
4. Build only `moonshine-jni`. Package `libmoonshine.so` and `moonshine-jni/libmoonshine-jni.so`, alongside the single existing ORT. ELF inspection confirmed the rebuilt libraries require `VERS_1.28.2` and have `0x4000` LOAD alignment. Other ABIs and model inference still need validation.
5. Extract only `classes.jar` from the pinned AAR, not its JNI libraries. Its POM dependencies are appcompat 1.6.1, material 1.10.0, okhttp 4.12.0 and work-runtime 2.9.1. Add release keep rules for `ai.moonshine.voice` JNI/reflected classes and fields. The AAR has no consumer ProGuard file.

`MOONSHINE_TTS_BUILD_ONNX=OFF` is broken in this source: `moonshine-c-api.cpp` unconditionally uses TTS/G2P while the corresponding macro is never consumed. The verified build leaves the default ON. This adds native TTS code but no espeak. A speech-only fork requires a deliberate upstream patch; do not claim the flag alone works.

## Adapter contract

Verified Java signatures: `Transcriber.loadFromFiles(directory, JNI.MOONSHINE_MODEL_ARCH_TINY_STREAMING)` (Tiny=2, Small=4); `transcribeWithoutStreaming(floatSamples, sampleRate)` returns a `Transcript` with `text()`; `close()` releases resources. Streaming supports `addListener`, `start`, `addAudio`, `stop` (final update), `close`.

Use app-owned capture and serialized inference. Do not use `MicTranscriber`, which introduces competing microphone ownership and automatic downloads. Never free native state while inference is running. Download integrity, selected-language support and full speech-plus-Qwen measurements are still implementation/acceptance work. Exact checkpoint licenses must be carried into Licenses when integrated.

## Local research locator

`/var/folders/ck/k7s7x5zs14jdcd7v97g479w00000gn/T/ow-moonshine-research-mcnift9t/` contains `models.json`, the pinned AAR, source archive and extracted source. Temporary verification build output was removed by its owning researcher. The source/checkpoint hashes above permit reconstruction if the temporary directory expires.

## Implementation checkpoint

The reproducible build now lives in `scripts/build-android-speech.py`. It verifies both Moonshine archives, extracts Java bindings only, and builds the native libraries against the same ORT as Sherpa. `MoonshineEngine` uses app-owned audio, decodes to 16 kHz PCM, feeds one-second blocks on one worker, flushes final lines, and closes the transcriber between jobs. Cancellation discards the result and releases resources on that worker. No automatic model downloads or second microphone owner are used. Word timestamps are absent rather than fabricated.

Android API 24 remains the app minimum. Moonshine download/selection/readiness and native invocation require API 26; Parakeet remains available on the existing path. English capability is checked against the full selected-language list before recording and again at inference. Native model choice is captured before waiting for the shared inference queue. Qwen releases both speech runtimes before loading text weights.

The model chooser discloses details on demand. Download integrity includes SHA-256 checks for existing files; same-size corruption can be replaced, and readiness caches only verified checksums with matching file modification metadata. Private Mode never falls back to a network provider.

### Distribution and attribution

Both canonical CDN configuration URLs still returned 403 during the refreshed check; immutable HF archive configurations returned 200. At that checkpoint the app used the verified archive for development downloads. The 2026-10-20 checkpoint above supersedes the hosting status; upstream describes HF as an archive, not its supported production serving endpoint.

English Tiny/Small weights and Moonshine code use MIT. App notices include upstream root terms and copyrights, cpp-annote MIT, bundled Eigen MPL-2.0 and a link to the covered source, kaldi-native-fbank Apache-2.0, utf8cpp Boost, nlohmann MIT, utf8proc/Unicode, Kiss FFT BSD, and Silero VAD MIT. Existing notices cover the actual ORT 1.28.2 binary and NDK runtime. The unmodified native build also embeds converted pyannote community-1 PLDA data and modified VCTK clips: their CC BY 4.0 attribution and modifications are included, although these capabilities are not exposed by the app. Upstream does not record the original PLDA checkpoint revision or exact VCTK corpus revision; that provenance limitation remains documented.

### Reproducible native smoke test

`modules/android-dictation/android/src/androidTest/.../SpeechRuntimeTest.kt` runs actual engines, not mocks. Build the isolated test APK with:

```sh
cd android
./gradlew :android-dictation:assembleDebugAndroidTest -PreactNativeArchitectures=arm64-v8a
```

Install `modules/android-dictation/android/build/outputs/apk/androidTest/debug/android-dictation-debug-androidTest.apk`. Its package is `com.openwhispr.dictation.test`; it does not change the signed-in development app. Put a synthetic `sample.wav` and checksum-verified `parakeet-v3/`, `moonshine-tiny/`, and `moonshine-small/` model directories in this test package's `files/fixtures/`. Use `adb push` to a unique `/data/local/tmp/` staging directory and `run-as com.openwhispr.dictation.test` to copy the owned fixtures, then remove staging. Run:

```sh
adb shell am instrument -w \
  -e class com.openwhispr.dictation.SpeechRuntimeTest \
  -e expectedWords fox,dog,meeting,notes \
  com.openwhispr.dictation.test/androidx.test.runner.AndroidJUnitRunner
```

The fixture says: “The quick brown fox jumps over the lazy dog. Please send the meeting notes tomorrow.” It is synthetic Samantha speech converted to mono PCM16/16 kHz. The test runs Parakeet, Tiny, Small, then Tiny again to exercise native coexistence and fresh per-recording state. `OWSpeechTest` logs elapsed decode/load/inference time. These are emulator smoke measurements, not physical-phone benchmarks or end-to-end Qwen recommendations. Instrumentation fails if fixtures are missing; ordinary mocked tests do not substitute for it.

### Emulator evidence (2026-10-15)

- ARM64 native library build and isolated test APK build passed. Emulator `OW_Research_Pixel_9` / `emulator-5554`, API 36, was reverified. All 16 Moonshine files were fully downloaded and size/SHA-256 verified; all four Parakeet files were likewise verified.
- Native smoke test passed twice, including Tiny → Small → Tiny in the same process as Parakeet. Initial 4.51675-second fixture: Parakeet 1,969 ms, Tiny 762 ms, Small 1,706 ms, repeated Tiny 1,011 ms (decode + model loading + speech inference; no Qwen cleanup). A repeated run under host load was slower; these values are not a physical-device speed comparison.
- Accuracy limitation: Parakeet matched the synthetic sentence. Tiny changed “tomorrow” to “to my email”; Small ended with “to my”. A comparison using upstream `transcribeWithoutStreaming` also misrecognized the tail (Tiny “to my email”, Small “to 911”). This is evidence of a quality limitation on this sample, not proof that the adapter drops trailing audio. Parakeet remains the default; do not recommend Moonshine on speed alone.
- Automated checks: six Jest suites / 44 tests passed, TypeScript passed, changed TypeScript ESLint had 0 errors (13 style warnings). Independent read-only review identified language-readiness and checksum-repair gaps; both were fixed and rechecked, including 28 focused tests run by the reviewer.
- Native evidence files remain outside the repository under `~/Desktop/Android Research/premium-2026-10-15/`: `moonshine-device-test.log`, `moonshine-device-batch-test.log`, `moonshine-native-results.log`, and build/check logs. The device test uses only generated speech and its own test package. Real microphone behavior, long recordings, non-synthetic accuracy, Qwen pipeline measurements, physical-phone minimums, and production model hosting remain acceptance work.
