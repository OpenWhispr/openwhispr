# Android development delivery

Source baseline: public OpenWhispr monorepo `2516e6e00`, 2026-10-14. Product brief: approved Android competitor review dated 2026-10-14. Private source transcripts and screenshots remain outside this repository.

## Decisions and reuse

Use the existing Expo SDK 55 / React Native 0.83 / Node 24 application. Keep the iOS root and screens intact; introduce Android-specific entry/navigation and onboarding where the platform differs. Reuse the SQLite migrations, notes/editor, dictionary/snippets stores, secure auth, provider policy and route snapshots, transcription/cleanup pipeline, prompts, languages, usage/referrals, and brand assets. Build an embedded-JavaScript development APK, without production OTA updates, to remove the morning dependency on Metro.

Android needs a Kotlin Expo module for a floating overlay, explicit-user microphone capture, WAV recording and safe insertion through Accessibility. No replacement keyboard. No reading passwords, crawling screens, automatic clicks, sending messages, or clipboard polling. Insertion must revalidate the same editable field and preserve selections. Overlay availability, microphone recording, and sync are separate settings. Disable stops recording and removes the overlay. System consent is obtained through normal settings UI.

Local speech uses NVIDIA Parakeet TDT 0.6B v3 via a speech-only Sherpa-ONNX 1.13.8 build on Android CPU, following Josh's 2026-10-14 steer. The iOS FluidAudio/CoreML implementation stays unchanged. Android exposes the int8 ONNX conversion (670,478,772 bytes across four verified files), with 25 European languages and automatic language detection. Unsupported explicit languages produce an actionable error, with no silent cloud or Whisper fallback. Long files use bounded 25-second intervals with overlapping context and word-timestamp ownership. See `parakeet.md` for exact build and measurement limits.

Apple Foundation Models cannot serve Android: llama.rn CPU generation provides Qwen2.5 0.5B Instruct (light) and 1.5B Instruct (balanced). Speech and text inference share a queue and release the idle runtime before allocating the other model. Benchmark the actual pairing on the emulator before claiming readiness. GPU/NPU, physical-device latency, thermal behavior and battery remain separate validation. Verify downloads before activating; never fall back to cloud silently.

Short onboarding: welcome → sign-in (four providers) or explicit local-only choice → language / processing → Dictate / Translate / Write & edit practice → optional cross-app access → late Pro information → ready. Local-only is a documented product assumption to keep unlimited local use possible without credentials. It does not represent a signed-in account or a trial. Practice success requires real pipeline output; sample-audio import is explicitly labeled and does not prove microphone capture.

Home / Notes / Dictionary / Style; Account top right. Reuse account/detail screens where sound, adding Android-specific models, permissions and history retention. Keep existing cloud entitlements/reward contract; 2,000 weekly words and one-month rewards/three-month bank remain proposals, not locally fabricated credits. No purchase/trial/invitation execution in this development delivery. Affiliate codes remain phase two.

## Execution sequence

1. Verify emulator/Play sign-in and keep host microphone off. Install pinned toolchain/dependencies, prebuild Android, compile baseline, fix native bootstrap errors.
2. Implement local cleanup runtime/model catalog and safe download lifecycle. Integrate Android with shared reasoning and transcription without changing iOS routes.
3. Implement overlay/recording/insertion module, foreground-service lifecycle, consent education, background disable and size controls.
4. Implement Android shell, guided practice, language sheet, Home metrics/history, Style and Account hierarchy; connect existing notes, dictionary/snippets, uploads, auth and provider configuration.
5. Exercise known WAV audio through the actual Android inference pipeline; unit/integration tests for lifecycle, route privacy, downloads, cancellation, retention and insertion. Inspect every meaningful screen on emulator and repair layout issues.
6. Self-review using code-quality checklist, run applicable shared/iPhone regression tests and native build; install self-contained APK, retain numbered evidence privately, push branch and attach draft PR. Record honest acceptance per requirement.

## Research references

- Android foreground service restrictions: https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- Android foreground service changes: https://developer.android.com/develop/background-work/services/fgs/changes
- Accessibility design: https://developer.android.com/guide/topics/ui/accessibility/views/service
- Editable node actions: https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo.AccessibilityAction
- Expo native development: https://docs.expo.dev/develop/development-builds/introduction/
- Android speech runtime: https://github.com/k2-fsa/sherpa-onnx
- Parakeet model: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- Android Parakeet documentation: https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html
- Local generation and accelerator constraints: https://github.com/mybigday/llama.rn
- Model card: https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF

Expo EAS can later provide managed builds/submission/updates; local Gradle is adequate for this review. Existing hosted API/auth/sync contracts are reused without deployment or migrations. No new paid tooling is needed. The authorized REA CLI investigation is recorded below.

## Model license decision

Qwen2.5 0.5B and 1.5B official GGUF releases are Apache-2.0 and selected. The 3B release reports a different license and is excluded. Speech uses Parakeet v3 (CC-BY-4.0; NVIDIA attribution plus ONNX conversion by the Sherpa-ONNX project), text offers two tiers. Downloads pin repository commits, exact byte counts and SHA-256, and activate only after verification. llama.rn is pinned to stable 0.12.3; experimental accelerator code is not enabled.

## REA investigation (authorized during execution)

Use the official `morluto/rea` CLI (`rea-agents`) selectively, without MCP registration or an agent restart. Verify CLI/JADX prerequisites, then inspect the retained reference apps' manifest/service declarations and narrowly scoped insertion/background behavior. Keep extracted APKs and private analysis outside the public repository. Evidence may inform platform decisions, but no proprietary source/assets are copied into OpenWhispr. Investigate: service lifetime/type; Accessibility selection and insertion; overlay gesture/background restrictions. Record observed facts separately from inferences and emulator tests.
