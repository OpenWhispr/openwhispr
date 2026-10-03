# Local Whisper on Processors Without AVX2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local Whisper transcribes on Windows and Linux PCs whose processor lacks AVX2 (Intel before Haswell, AMD FX, AMD Jaguar), instead of failing with "whisper-server process died during startup" (#2356; also reported in #1418, #1613 and #793).

**Architecture:** The OpenWhispr/whisper.cpp fork builds two extra CPU-only whisper-server binaries per platform (win32-x64, linux-x64) at upstream ggml's `ivybridge` level (SSE4.2 + AVX + F16C) and `sandybridge` level (SSE4.2 + AVX). CI proves each one under an emulator of exactly that processor. The desktop app ships them next to the primary build. When a CPU build dies at startup from an illegal instruction, `WhisperServerManager` retries one level down and keeps the build that starts for the rest of the session.

**Tech Stack:** GitHub Actions (MSVC 19.44 on windows-2022, GCC 11.4 on ubuntu-22.04), CMake, Intel SDE 9.58, QEMU 8.2 user mode, Python 3 (stdlib only), Electron main process (CommonJS), `node:test` + `node:assert/strict`.

**Spec:** No spec file. The brief is #2356 plus the diagnosis summarised under "Diagnosis check" below; this plan records where it departs from the proposed design and why.

## In plain words

The speech engine that ships with OpenWhispr is compiled to use newer processor instructions (called AVX2). Processors from before about 2013 lack them. When the engine reaches one of those instructions, the operating system stops it immediately, and the app shows a confusing error. The fix builds two more copies of the engine for older processors. The app keeps the fast copy and, only when that copy is stopped this way, tries the next copy down. It uses whichever copy works for the rest of the session. Nothing changes on computers the current engine already runs on.

## Global Constraints

- Fork PRs target **OpenWhispr/whisper.cpp `master`**, never ggml-org/whisper.cpp. Always pass `--repo OpenWhispr/whisper.cpp` to `gh`, because the fork's parent is ggml-org and `gh pr create` can default to the parent.
- Desktop PRs target **OpenWhispr/openwhispr `main`**.
- This plan pushes branches and opens **draft** PRs. It never merges, tags, publishes a release, or dispatches `build-binaries.yml`. A `workflow_dispatch` of that workflow **publishes a release**, even from a branch. The 0.0.11 release is a human step (Part R).
- PR text uses `Refs #N`. Never write close/fix/resolve before an issue number: #2356 closes by hand after the app release that ships the fix. Do not @mention anyone.
- The desktop repo is public: no customer names or email addresses, and no internal links, anywhere.
- CPU level names are exactly `ivybridge` and `sandybridge`. Release assets: `whisper-server-{win32,linux}-x64-cpu-{ivybridge,sandybridge}.zip`, containing `whisper-server-{win32,linux}-x64-cpu-{level}[.exe]`. Desktop output names: `whisper-server-{platform}-{arch}-{level}[.exe]`.
- Exact configure lines. The primary lines must stay exactly as they are today.
  - Windows primary: `-- Adding CPU backend variant ggml-cpu: /arch:AVX2 GGML_AVX2;GGML_FMA;GGML_F16C;__BMI2__;GGML_BMI2`
  - Windows ivybridge and sandybridge (both): `-- Adding CPU backend variant ggml-cpu: /arch:AVX GGML_AVX`
  - Linux primary: `-- Adding CPU backend variant ggml-cpu: -msse4.2;-mf16c;-mfma;-mbmi2;-mavx;-mavx2 GGML_SSE42;GGML_F16C;GGML_FMA;GGML_BMI2;GGML_AVX;GGML_AVX2`
  - Linux ivybridge: `-- Adding CPU backend variant ggml-cpu: -msse4.2;-mf16c;-mavx GGML_SSE42;GGML_F16C;GGML_AVX`
  - Linux sandybridge: `-- Adding CPU backend variant ggml-cpu: -msse4.2;-mavx GGML_SSE42;GGML_AVX`
- Pinned downloads (sha256):
  - `ggml-tiny.bin`: `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21` (its sha1 matches `models/README.md`)
  - `ggml-silero-v5.1.2.bin`: `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf`
  - `sde-external-9.58.0-2025-06-16-win.tar.xz`: `ebb8b3b63fcb0b6c1f9721118ba4883703d2aed9e0db2defed4e44fba78d9ca9`
  - `llama-b9763-bin-win-cpu-x64.zip`: `05144ee4d885a778ebaef619f79ca0b8a4edb7f017eaf70086a8781ff003815f`
  - `llama-b9763-bin-ubuntu-x64.tar.gz`: `4bd11fe0cea35223b240496062900ed9493b46f20a08747d431bfdc2252af2d8`
- Desktop: Node 24 (`.nvmrc`), tests run with `node --import tsx --test`, no lockfile changes. Run `npx prettier --write` on every changed JS and markdown file (the originals are Prettier-clean).
- Fork CI script: Python standard library only, runnable on Python 3.9 (local smoke test) and 3.12 (CI).
- End every commit message with the attribution line your harness specifies.

## Review Focus

1. **Another startup crash** (SIGSEGV, an abort, or a missing-DLL exit code) on the CPU build must fail exactly as before and must not switch builds. Pinned by the D2 test "any other startup crash fails as before and keeps the primary build".
2. **Launch pre-warm and the first dictation racing** through the switch must share one fallback. Pinned by the D2 test "two starts racing through the switch share one fallback".
3. **The new error must reach the user as thrown.** `transcribe-local-whisper` in `ipcHandlers.js` relabels messages that contain `whisper-cpp`, `FFmpeg`, `not downloaded` or `Audio buffer is empty`, so the message must contain none of them. Pinned in the D2 test "with no build for older processors installed…".
4. **A release that lacks one fallback asset** must fail the desktop build, not ship without it. Pinned by the D3 test "--current installs every build configured for the platform and fails if any is missing", by the D4 entries test, and by afterPack's `verifyWhisperServerFallbackBuilds` (A4), which fails packaging whenever a listed fallback build is not in `resources/bin`, whatever the download script did.
5. **The Windows exit code in signed form** (-1073741795, as cmd shows it) must still count as an illegal instruction. Pinned in the D2 `isIllegalInstructionExit` test.

---

## Diagnosis check

What I checked, against the fork at tag 0.0.10 (6ac1454), the desktop at origin/main 86e40760, and the 0.0.10 CI logs:

- **Confirmed: every CPU build needs AVX2, FMA, F16C and BMI2.** `GGML_NATIVE=OFF` sets `INS_ENB` (`ggml/CMakeLists.txt:141-145`). The 0.0.10 logs print exactly the primary lines listed under Global Constraints.
- **Confirmed: it dies before the server can answer.** `main()` calls `ggml_backend_load_all()` first (`examples/server/server.cpp:633`), loads the model at line 717 and binds the port at line 1244. `ggml_cpu_init()` builds the fp16 tables with F16C and FMA code and a BMI2 `shlx` (`ggml-cpu.c:3785-3799`). The Linux build hits `vfmadd213ss` (FMA) in `ggml_cpu_init` first, and #1613's fault offset is the `shlx`. The desktop only ever sees a startup death, which is what the fallback relies on.
- **Refined: "even on --help" holds only when a ggml library sits beside the exe.** `ggml_backend_load_best()` touches the registry only when it finds a matching `ggml-*.dll` or `libggml-*.so` in the exe folder or the working folder (`ggml-backend-reg.cpp:473-553`). OpenWhispr's `resources/bin` has llama.cpp's, so there the crash comes at `load_all`. In an empty folder (CI) the registry is built later, inside model load. So **CI must start the server with a model, never with `--help`,** or the check that the primary gets rejected proves nothing.
- **~~Refined: the next level down also dies at startup.~~ Disproved by the first fork CI run; see A3.** On x86, `ggml_cpu_init` builds its fp16 tables with the scalar `GGML_COMPUTE_FP16_TO_FP32` / `GGML_COMPUTE_FP32_TO_FP16`; F16C first runs in the transcription kernels. Both emulators showed the ivybridge build serving on a Sandy Bridge. The level check added in A3 is what makes it stop at startup.
- **New: one Sandy Bridge-level build would be far slower than needed on every reported processor.** Every processor named in the reports (i3-3110M, i5-3570, FX-8350, AMD Jaguar) has F16C. Without F16C, ggml loads every fp16 weight one element at a time through a 256 KB lookup table and a stack buffer (`simd-mappings.h:636-644`), and whisper's models are fp16. Local x86_64 builds with the plan's flags, on the same host and model, interleaved (host heavily loaded, and under Rosetta, so ratios only): AVX2 build 6.3–8.2 s per jfk.wav request, ivybridge 6.6–11.6 s, sandybridge 48–85 s. So the plan ships both levels; see Decision 1.
- **Checked locally: the flags do what they say.** Clang x86_64 builds with the GCC-branch flags printed exactly the Linux ivybridge and sandybridge lines above. A disassembly count found 0 AVX2, FMA3 or BMI2 instructions in either build; ivybridge has 40 F16C instructions, sandybridge none. The only hits were one `dr_wav` data word decoded as AVX-512, and `dr_flac`'s LZCNT, which sits behind a CPUID check. MSVC is only seen in CI.
- **Checked locally: the verification script works.** Run natively on those builds, it transcribed jfk.wav with Silero VAD at both levels, read `AVX` and `AVX F16C` from each build's `system_info` line, and failed both rejection checks as designed, since nothing was emulated.
- **Checked locally: the desktop change works.** It was applied in a scratch copy of this worktree. Nine of the 11 new tests failed before the change for the reported reasons (`whisper-server process died during startup`, and a second launch of the crashing build); the other two pin behaviour that must not change. All 11 pass after it. The related suites pass: whisperServer*, downloadWhisperCpp and gpuBinaryManager. `npm test` also fails in markdownRenderer, richTextEditor, assistantPanel, chatMessageApprovals and enterpriseIdentityStoreImports, and `npm run typecheck` in RichTextEditorTableMenu.tsx. All of those fail the same way in the untouched worktree (local `node_modules` drift), so they are not caused by this change. One timing test, textEditMonitorSelection, failed once on the loaded host and passes when run alone.
- **Confirmed, with a risk the proposal did not size: llama.cpp's libraries.** llama.cpp b9763 uses the same `GGML_BACKEND_API_VERSION` (2), so whisper-server loads every llama `ggml-cpu-*.dll` to score it and registers the best one as a second CPU device. whisper.cpp computes on the first CPU device only (`src/whisper.cpp:1352`), so it goes unused. Loading still runs code on the user's processor, so the fallback builds are also checked in that layout (Decision 5, check 5).
- **Confirmed: packaging needs no change.** `electron-builder.json` ships `whisper-server-*` and `*.dll`/`*.so*` from `resources/bin`. `cleanupFiles` keeps anything starting `whisper-server-<platform>-<arch>`. Nix wraps the AppImage.
- **Confirmed: bumping the tag needs the GPU digests in the same commit.** `test/helpers/gpuBinaryManager.test.js` expects a pinned digest for the current tag and asserts `/tags/0.0.10$/` (line 166). A tag bump without 0.0.11 digests fails three GPU tests (tried in the scratch copy).
- **Confirmed: releases have only ever been dispatched on master** (every run of build-binaries.yml), and the workflow has no PR trigger. So fork PR #6 was never built before it merged. Task F1 adds one.

## Design decisions (changes from the proposed design)

1. **Two CPU levels, not one.** Build `ivybridge` (AVX + F16C) and `sandybridge` (AVX) per platform, and fall back in that order. A single `sandybridge` build would run every reported CPU about 6–7x slower than necessary (measured above). A single `ivybridge` build would leave Sandy Bridge and Bulldozer broken. The cost is one more ~1–3 min build per platform, and one more emulated run in CI.
2. **Name the builds after ggml's levels, not `noavx2`.** Once there are two builds, "noavx2" describes both. `ivybridge` and `sandybridge` are upstream ggml's own names for these exact feature sets (`ggml/src/CMakeLists.txt:378-386`). llama.cpp's `ggml-cpu-ivybridge.dll` and `ggml-cpu-sandybridge.dll`, already in `resources/bin`, carry the same names. "baseline" means SSE4.2 elsewhere, and "avx" reads like an accelerated build. The app's log line and TROUBLESHOOTING say "a build for older processors" in plain words.
3. **MSVC ivybridge through `CFLAGS=/D__F16C__`.** MSVC has no switch for F16C without AVX2, which is why upstream builds no MSVC ivybridge variant. Defining the macro turns on ggml's F16C code, which MSVC compiles from intrinsics under `/arch:AVX`. Nothing outside ggml-cpu reads `__F16C__`. Any AVX2 intrinsic in ggml sits behind `__AVX2__`: the clang build with `-mf16c -mavx` would refuse to compile one otherwise. Because MSVC prints the same configure line for both levels, the build job checks the CMake cache, and CI checks the binary's own `system_info` report.
4. **Verify the uploaded zips in their own matrix job.** Both legs run on clean runners with Python from `actions/setup-python`. The Windows CPU job's disk cleanup targets a toolcache Python path, and Linux needs ubuntu-24.04 for QEMU ≥ 7.2 (22.04 ships 6.2, which cannot emulate AVX). This job gates `create-release`.
5. **Six checks per platform** (five as planned, check 5 extended during execution; see Amendments). (1) ivybridge transcribes on an emulated Ivy Bridge. (2) sandybridge transcribes on an emulated Sandy Bridge. (3) The primary is stopped at startup on Ivy Bridge. (4) The ivybridge build is stopped at startup on Sandy Bridge. (5) Each fallback build still starts with llama.cpp's libraries beside it, on its own level. Checks 3 and 4 prove the emulator enforces the level, and prove the desktop's assumption that a build dies at startup. One run per level has Silero VAD on (the notes and meetings default), which covers VAD and whisper together. There is no static instruction-count gate: MSVC's STL and miniaudio dispatch on CPUID, so a static count would flag code that never runs. Check 5 can be dropped by removing `--with-llama-libraries` from the workflow.
6. **Desktop: no new state.** Caching the fallback path in the existing `cachedServerBinaryPath` is the sticky switch: `stop()` never clears it, and `getServerBinaryPath` is unchanged. No `stop()` call is needed either: the process has exited and its close handler cleaned up, so `gpuFallbackActive` is untouched without the save-and-restore dance. Fallback builds are looked up **next to the build that died**, not through `resolveBinaryPath`. That keeps one install's builds together, and keeps the tests hermetic against a developer's own `resources/bin`.
7. **Desktop download: follow `download-llama-server.js`'s per-build entries.** Each entry is keyed by build and grouped by `platformArch`, and every entry is required. This replaces a nested second binary per platform. Each entry gets its own install marker (`.whisper-cpp-<key>.json`; the primary keys and markers are unchanged). Land the machinery now. Land the entries, tag and digests after 0.0.11 exists, because CI downloads the pinned release on every PR.
8. **Kept from the proposal.** #2317's names for the close signal (`exitSignal`, `getProcessInfo` returning `{ stderr, exitCode, signal }`), to limit merge conflicts. No persistence to `.env`: the crash costs ~0.1–0.5 s once per launch, during pre-warm, and a new app version then gets a fresh try of the primary. No new UI or translations, which is #963's scope. The error keeps `exit code: 3221225501` or `signal: SIGILL`, which #963's regex matches.

## Amendments during execution

The committed fork and desktop code is authoritative where it differs from the steps below.

- **A1 (Task F2, Windows level check):** the ivybridge cache check asserts `/D__F16C__` in both `CMAKE_C_FLAGS` and `CMAKE_CXX_FLAGS`, and its absence from both for sandybridge. ggml's F16C table code is C (`ggml-cpu.c`), so the C++-only check could pass with the C define missing.
- **A2 (Task F3, check 5):** the llama.cpp layout check runs for both fallback builds, each on its own level, and copies whisper.cpp's files first and llama.cpp's second. `release.yml` downloads whisper.cpp then llama.cpp into the same `resources/bin`, so llama's files win a name clash there too.
- **A3 (fork, new): a startup level check, because check 4 failed.** Fork run 36502940851 (commit 0c73de8) passed every check except 4 on both platforms: the ivybridge build started and served on an emulated Sandy Bridge, so on a real one it would only have crashed mid-transcription, which the desktop fallback cannot see. Fork commit 1e57d00 adds `examples/server/cpu-level-check.cpp`: before `main()` it compares ggml's compiled-in sets (`ggml_cpu_has_avx/f16c/fma/avx2/bmi2`) with CPUID and XGETBV, prints `whisper-server: built for <set>, which this processor does not support`, and raises `ud2` (SIGILL / 0xC000001D, which `isIllegalInstructionExit` already classifies). It is opt-in (`OPENWHISPR_CPU_LEVEL_CHECK`) and enabled only for the ivybridge and sandybridge builds: Rosetta 2 reports no AVX in CPUID yet runs AVX2 code (confirmed locally; `ROSETTA_ADVERTISE_AVX=1` changes that), so a CPUID check on the primary could move a hypervisor or translator user off a build that works for them. `verify-cpu-levels.py` accepts the resulting illegal-instruction exit under SDE and requires the ivybridge build's refusal on Sandy Bridge to come from the check. Run 36504535683 (1e57d00): all 12 checks pass. **The desktop now depends on the 0.0.11 release containing this commit** (D4 Step 1 must confirm `verify-cpu-levels` passed on the release run).
- **A4 (desktop, from the independent review):** documentation that describes the shipped fallback moves to D4 (the TROUBLESHOOTING line, and the CLAUDE.md sentence on which platforms get the builds), so no commit claims behaviour it cannot deliver; the spawning tests get a 30 s timeout so a relaunch loop fails instead of hanging CI; and afterPack gains `verifyWhisperServerFallbackBuilds`, which fails packaging when a fallback build that `download-whisper-cpp.js` lists for the platform is missing from `resources/bin` (a no-op until D4 lists them; the primary is left to the download step, so packaging another arch of the same OS without downloading its builds is unchanged). After D4, packaging for another OS without downloading that OS's builds (e.g. `npm run build:linux` on a Mac without `TARGET_PLATFORM`) fails here, loudly, where it used to ship a package missing even the primary build.

## File structure

OpenWhispr/whisper.cpp (clone at `~/dev/openwhispr-whisper-cpp-2356`, branch `build/whisper-server-cpu-levels` from `master` = 0.0.10):

- Modify `.github/workflows/build-binaries.yml`: PR trigger, permissions, the two extra CPU builds, packaging, release files and notes, and the verify job.
- Create `.github/scripts/verify-cpu-levels.py`: runs each build on its emulated processor. CI-only, so it lives under `.github/`, away from upstream's `scripts/`.

OpenWhispr/openwhispr (this worktree, branch `fix/2356-no-avx2-cpu-fallback`):

- Modify `src/helpers/whisperServer.js`: exit signal, `isIllegalInstructionExit`, `getCpuFallbackBinaryPath`, and the fallback in `_doStart`.
- Modify `src/helpers/whisperCppRelease.js`: `CPU_FALLBACK_LEVELS` and `cpuFallbackServerBinaryName` (shared by the runtime and the download script).
- Create `test/helpers/whisperServerCpuFallback.test.js`.
- Modify `scripts/download-whisper-cpp.js` and `test/scripts/downloadWhisperCpp.test.js`.
- Modify `CLAUDE.md` and `TROUBLESHOOTING.md`.
- After 0.0.11 only: `src/helpers/whisperCudaManager.js`, `src/helpers/whisperVulkanManager.js`, `test/helpers/gpuBinaryManager.test.js`, and a comment in `src/utils/gpuDetection.js`.

---

## Part F — OpenWhispr/whisper.cpp

### Task F1: Build and check the CPU binaries on PRs that change the build

**Files:**
- Modify: `.github/workflows/build-binaries.yml` (lines 3-15, and the job headers of the six GPU/macOS jobs and `create-release`)

**Interfaces:**
- Produces: `pull_request` runs that execute only `build-windows-x64-cpu`, `build-linux-x64-cpu` and (after F3) `verify-cpu-levels`. `create-release` alone holds `contents: write`.

- [ ] **Step 1: Branch**

```bash
cd ~/dev/openwhispr-whisper-cpp-2356
git fetch origin && git switch master && git pull --ff-only
git log --oneline 0.0.10..origin/master   # expect nothing; if anything landed since 0.0.10, note it for the fork PR body and Part R
git switch -c build/whisper-server-cpu-levels
```

- [ ] **Step 2: Add the trigger and least-privilege permissions**

Replace:

```yaml
  push:
    tags:
      - 'openwhispr-*'

permissions:
  contents: write
```

with:

```yaml
  push:
    tags:
      - 'openwhispr-*'
  # A PR that changes the build proves it before a release: it builds the CPU
  # binaries and runs their checks. The GPU and macOS builds and the release
  # skip pull_request runs (see their `if:`).
  pull_request:
    branches: [master]
    paths:
      - '.github/workflows/build-binaries.yml'
      - '.github/scripts/**'

# Read-only by default. Only create-release writes (it publishes the release).
permissions:
  contents: read
```

- [ ] **Step 3: Skip the GPU and macOS builds on PRs**

Insert `    if: github.event_name != 'pull_request'` as the first line under each of these job keys, above its `runs-on:`:
- `build-macos-arm64:`
- `build-macos-x64:`
- `build-windows-x64-cuda:`
- `build-linux-x64-cuda:`
- `build-linux-x64-vulkan:`
- `build-windows-x64-vulkan:`

Anchor each edit on the job key: several jobs share the same `runs-on:` line. Example:

```yaml
  build-windows-x64-cuda:
    if: github.event_name != 'pull_request'
    runs-on: windows-2022
```

- [ ] **Step 4: Gate the release and give it the only write token**

Replace:

```yaml
  create-release:
    needs: [build-macos-arm64, build-macos-x64, build-windows-x64-cpu, build-windows-x64-cuda, build-windows-x64-vulkan, build-linux-x64-cpu, build-linux-x64-cuda, build-linux-x64-vulkan]
    runs-on: ubuntu-latest
```

with:

```yaml
  create-release:
    if: github.event_name != 'pull_request'
    needs: [build-macos-arm64, build-macos-x64, build-windows-x64-cpu, build-windows-x64-cuda, build-windows-x64-vulkan, build-linux-x64-cpu, build-linux-x64-cuda, build-linux-x64-vulkan]
    runs-on: ubuntu-latest
    permissions:
      contents: write
```

- [ ] **Step 5: Lint**

```bash
python3 -m venv /tmp/wf-venv && /tmp/wf-venv/bin/pip install -q actionlint-py
/tmp/wf-venv/bin/actionlint .github/workflows/build-binaries.yml
```

Expected: one finding only, the pre-existing `the runner of "softprops/action-gh-release@v1" action is too old`. Upgrading that action is out of scope, because the release step is not exercised here.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/build-binaries.yml
git commit -m "ci: build and check the CPU binaries on PRs that change the build"
```

### Task F2: whisper-server for Ivy Bridge- and Sandy Bridge-level processors

**Files:**
- Modify: `.github/workflows/build-binaries.yml` (Windows CPU job lines 168-229, Linux CPU job lines 429-461, create-release lines 720-790)

**Interfaces:**
- Consumes: F1's workflow.
- Produces: the artifacts `whisper-server-win32-x64-cpu-ivybridge`, `whisper-server-win32-x64-cpu-sandybridge`, `whisper-server-linux-x64-cpu-ivybridge` and `whisper-server-linux-x64-cpu-sandybridge`, each holding the same-named `.zip`. Each win32 zip holds `whisper-server-win32-x64-cpu-<level>.exe` plus the four MSVC runtime DLLs; each linux zip holds `whisper-server-linux-x64-cpu-<level>`. F3's verify job and create-release consume them.

- [ ] **Step 1: Windows: two builds and the level check, after "Build whisper.cpp (CPU-only)"**

Replace:

```yaml
            -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
          cmake --build build --config Release -j %NUMBER_OF_PROCESSORS%

      - name: Package binaries
        shell: pwsh
        run: |
          mkdir dist
          Copy-Item build\bin\Release\whisper-cli.exe dist\whisper-cpp-win32-x64-cpu.exe
          Copy-Item build\bin\Release\whisper-server.exe dist\whisper-server-win32-x64-cpu.exe
```

(this block is unique: it is the CPU job's build step followed by its package step) with:

```yaml
            -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
          cmake --build build --config Release -j %NUMBER_OF_PROCESSORS%

      # The build above needs AVX2, FMA, F16C and BMI2 (GGML_NATIVE=OFF turns them
      # all on) and dies at startup with STATUS_ILLEGAL_INSTRUCTION on Intel before
      # Haswell and on AMD FX (OpenWhispr/openwhispr#2356). These two whisper-server
      # builds use upstream ggml's ivybridge (SSE4.2 + AVX + F16C) and sandybridge
      # (SSE4.2 + AVX) CPU levels; OpenWhispr falls back through them in that order.
      - name: Build whisper-server for Ivy Bridge-level processors
        shell: cmd
        env:
          # MSVC has no switch for F16C without AVX2, which is why upstream ggml has
          # no ivybridge variant on MSVC. Defining the macro turns on ggml's F16C code,
          # which MSVC compiles from intrinsics under /arch:AVX. CMake reads CFLAGS and
          # CXXFLAGS only when it first configures a build tree.
          CFLAGS: /D__F16C__
          CXXFLAGS: /D__F16C__
        run: |
          cmake -S . -B build-ivybridge -G "Ninja Multi-Config" ^
            -DCMAKE_BUILD_TYPE=Release ^
            -DCMAKE_C_COMPILER_LAUNCHER=sccache ^
            -DCMAKE_CXX_COMPILER_LAUNCHER=sccache ^
            -DBUILD_SHARED_LIBS=OFF ^
            -DGGML_NATIVE=OFF ^
            -DGGML_CUDA=OFF ^
            -DGGML_AVX=ON ^
            -DGGML_AVX2=OFF ^
            -DGGML_BMI2=OFF ^
            -DGGML_AVX512=OFF ^
            -DGGML_AVX_VNNI=OFF ^
            -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded || exit /b 1
          cmake --build build-ivybridge --config Release --target whisper-server -j %NUMBER_OF_PROCESSORS%

      - name: Build whisper-server for Sandy Bridge-level processors
        shell: cmd
        run: |
          cmake -S . -B build-sandybridge -G "Ninja Multi-Config" ^
            -DCMAKE_BUILD_TYPE=Release ^
            -DCMAKE_C_COMPILER_LAUNCHER=sccache ^
            -DCMAKE_CXX_COMPILER_LAUNCHER=sccache ^
            -DBUILD_SHARED_LIBS=OFF ^
            -DGGML_NATIVE=OFF ^
            -DGGML_CUDA=OFF ^
            -DGGML_AVX=ON ^
            -DGGML_AVX2=OFF ^
            -DGGML_BMI2=OFF ^
            -DGGML_AVX512=OFF ^
            -DGGML_AVX_VNNI=OFF ^
            -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded || exit /b 1
          cmake --build build-sandybridge --config Release --target whisper-server -j %NUMBER_OF_PROCESSORS%

      - name: Check each build's CPU level
        # Whole lines: "/arch:AVX GGML_AVX" is also the start of what a missing
        # GGML_BMI2=OFF produces ("/arch:AVX GGML_AVX;__BMI2__;GGML_BMI2"). Configuring
        # a configured tree again prints the line without rebuilding. MSVC prints the
        # same line for both levels, so F16C is checked in the cache here and in the
        # binary's own report by verify-cpu-levels.
        shell: pwsh
        run: |
          function Assert-CpuVariant([string]$BuildDir, [string]$Expected) {
            $found = @(cmake -S . -B $BuildDir | Where-Object { $_ -like '-- Adding CPU backend variant *' })
            if ($LASTEXITCODE -ne 0) { throw "configuring $BuildDir failed" }
            Write-Host "${BuildDir}: $($found -join ' | ')"
            if ($found.Count -ne 1 -or $found[0] -cne $Expected) { throw "${BuildDir}: expected '$Expected'" }
          }
          function Test-F16cDefine([string]$BuildDir) {
            return [bool](Select-String -Path "$BuildDir\CMakeCache.txt" -Pattern '^CMAKE_CXX_FLAGS:STRING=.*/D__F16C__' -Quiet)
          }
          Assert-CpuVariant build '-- Adding CPU backend variant ggml-cpu: /arch:AVX2 GGML_AVX2;GGML_FMA;GGML_F16C;__BMI2__;GGML_BMI2'
          Assert-CpuVariant build-ivybridge '-- Adding CPU backend variant ggml-cpu: /arch:AVX GGML_AVX'
          Assert-CpuVariant build-sandybridge '-- Adding CPU backend variant ggml-cpu: /arch:AVX GGML_AVX'
          if (-not (Test-F16cDefine build-ivybridge)) { throw "build-ivybridge: CMAKE_CXX_FLAGS lacks /D__F16C__" }
          if (Test-F16cDefine build-sandybridge) { throw "build-sandybridge: CMAKE_CXX_FLAGS has /D__F16C__" }

      - name: Package binaries
        shell: pwsh
        run: |
          mkdir dist
          Copy-Item build\bin\Release\whisper-cli.exe dist\whisper-cpp-win32-x64-cpu.exe
          Copy-Item build\bin\Release\whisper-server.exe dist\whisper-server-win32-x64-cpu.exe
          foreach ($level in @("ivybridge", "sandybridge")) {
            Copy-Item "build-$level\bin\Release\whisper-server.exe" "dist\whisper-server-win32-x64-cpu-$level.exe"
          }
```

- [ ] **Step 2: Windows: zip the two builds with the same runtime DLLs**

In the same Package step, replace:

```powershell
          Compress-Archive -Path (@("whisper-cpp-win32-x64-cpu.exe") + $runtimeDlls) -DestinationPath whisper-cpp-win32-x64-cpu.zip
          Compress-Archive -Path (@("whisper-server-win32-x64-cpu.exe") + $runtimeDlls) -DestinationPath whisper-server-win32-x64-cpu.zip
```

with:

```powershell
          Compress-Archive -Path (@("whisper-cpp-win32-x64-cpu.exe") + $runtimeDlls) -DestinationPath whisper-cpp-win32-x64-cpu.zip
          Compress-Archive -Path (@("whisper-server-win32-x64-cpu.exe") + $runtimeDlls) -DestinationPath whisper-server-win32-x64-cpu.zip
          foreach ($level in @("ivybridge", "sandybridge")) {
            Compress-Archive -Path (@("whisper-server-win32-x64-cpu-$level.exe") + $runtimeDlls) -DestinationPath "whisper-server-win32-x64-cpu-$level.zip"
          }
```

The existing "Verify zips contain the MSVC runtime DLLs" step loops over `dist\*.zip`, so it covers the new zips unchanged. All zips take the DLLs from the same `dist\` files, so the desktop's flat copy writes identical bytes.

- [ ] **Step 3: Windows: upload the two zips**

Replace:

```yaml
      - name: Upload whisper-server artifact
        uses: actions/upload-artifact@v4
        with:
          name: whisper-server-win32-x64-cpu
          path: dist/whisper-server-win32-x64-cpu.zip
```

with:

```yaml
      - name: Upload whisper-server artifact
        uses: actions/upload-artifact@v4
        with:
          name: whisper-server-win32-x64-cpu
          path: dist/whisper-server-win32-x64-cpu.zip

      - name: Upload whisper-server Ivy Bridge-level artifact
        uses: actions/upload-artifact@v4
        with:
          name: whisper-server-win32-x64-cpu-ivybridge
          path: dist/whisper-server-win32-x64-cpu-ivybridge.zip

      - name: Upload whisper-server Sandy Bridge-level artifact
        uses: actions/upload-artifact@v4
        with:
          name: whisper-server-win32-x64-cpu-sandybridge
          path: dist/whisper-server-win32-x64-cpu-sandybridge.zip
```

- [ ] **Step 4: Linux: two builds, the level check, and packaging**

Replace:

```yaml
            -DGGML_NATIVE=OFF \
            -DGGML_CUDA=OFF
          cmake --build build --config Release -j $(nproc)

      - name: Package binaries
        run: |
          mkdir -p dist
          cp build/bin/whisper-cli dist/whisper-cpp-linux-x64-cpu
          chmod +x dist/whisper-cpp-linux-x64-cpu
          cp build/bin/whisper-server dist/whisper-server-linux-x64-cpu
          chmod +x dist/whisper-server-linux-x64-cpu
          cd dist
          zip whisper-cpp-linux-x64-cpu.zip whisper-cpp-linux-x64-cpu
          zip whisper-server-linux-x64-cpu.zip whisper-server-linux-x64-cpu
```

with:

```yaml
            -DGGML_NATIVE=OFF \
            -DGGML_CUDA=OFF
          cmake --build build --config Release -j $(nproc)

      # The ivybridge and sandybridge whisper-server builds for processors without
      # AVX2; see the Windows CPU job. GCC switches F16C and FMA separately, so both
      # are set explicitly.
      - name: Build whisper-server for Ivy Bridge-level processors
        run: |
          cmake -B build-ivybridge \
            -DCMAKE_BUILD_TYPE=Release \
            -DCMAKE_C_COMPILER_LAUNCHER=ccache \
            -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
            -DBUILD_SHARED_LIBS=OFF \
            -DGGML_NATIVE=OFF \
            -DGGML_CUDA=OFF \
            -DGGML_SSE42=ON \
            -DGGML_AVX=ON \
            -DGGML_F16C=ON \
            -DGGML_FMA=OFF \
            -DGGML_BMI2=OFF \
            -DGGML_AVX2=OFF
          cmake --build build-ivybridge --config Release --target whisper-server -j $(nproc)

      - name: Build whisper-server for Sandy Bridge-level processors
        run: |
          cmake -B build-sandybridge \
            -DCMAKE_BUILD_TYPE=Release \
            -DCMAKE_C_COMPILER_LAUNCHER=ccache \
            -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
            -DBUILD_SHARED_LIBS=OFF \
            -DGGML_NATIVE=OFF \
            -DGGML_CUDA=OFF \
            -DGGML_SSE42=ON \
            -DGGML_AVX=ON \
            -DGGML_F16C=OFF \
            -DGGML_FMA=OFF \
            -DGGML_BMI2=OFF \
            -DGGML_AVX2=OFF
          cmake --build build-sandybridge --config Release --target whisper-server -j $(nproc)

      - name: Check each build's CPU level
        # Whole lines, not substrings; see the Windows CPU job
        run: |
          check() {
            found=$(cmake -S . -B "$1" | grep -- '^-- Adding CPU backend variant ' || true)
            echo "$1: $found"
            [ "$found" = "$2" ] || { echo "::error::$1: expected '$2'"; exit 1; }
          }
          check build '-- Adding CPU backend variant ggml-cpu: -msse4.2;-mf16c;-mfma;-mbmi2;-mavx;-mavx2 GGML_SSE42;GGML_F16C;GGML_FMA;GGML_BMI2;GGML_AVX;GGML_AVX2'
          check build-ivybridge '-- Adding CPU backend variant ggml-cpu: -msse4.2;-mf16c;-mavx GGML_SSE42;GGML_F16C;GGML_AVX'
          check build-sandybridge '-- Adding CPU backend variant ggml-cpu: -msse4.2;-mavx GGML_SSE42;GGML_AVX'

      - name: Package binaries
        run: |
          mkdir -p dist
          cp build/bin/whisper-cli dist/whisper-cpp-linux-x64-cpu
          chmod +x dist/whisper-cpp-linux-x64-cpu
          cp build/bin/whisper-server dist/whisper-server-linux-x64-cpu
          chmod +x dist/whisper-server-linux-x64-cpu
          for level in ivybridge sandybridge; do
            cp "build-$level/bin/whisper-server" "dist/whisper-server-linux-x64-cpu-$level"
            chmod +x "dist/whisper-server-linux-x64-cpu-$level"
          done
          cd dist
          zip whisper-cpp-linux-x64-cpu.zip whisper-cpp-linux-x64-cpu
          zip whisper-server-linux-x64-cpu.zip whisper-server-linux-x64-cpu
          for level in ivybridge sandybridge; do
            zip "whisper-server-linux-x64-cpu-$level.zip" "whisper-server-linux-x64-cpu-$level"
          done
```

- [ ] **Step 5: Linux: upload the two zips**

Replace:

```yaml
      - name: Upload whisper-server artifact
        uses: actions/upload-artifact@v4
        with:
          name: whisper-server-linux-x64-cpu
          path: dist/whisper-server-linux-x64-cpu.zip
```

with:

```yaml
      - name: Upload whisper-server artifact
        uses: actions/upload-artifact@v4
        with:
          name: whisper-server-linux-x64-cpu
          path: dist/whisper-server-linux-x64-cpu.zip

      - name: Upload whisper-server Ivy Bridge-level artifact
        uses: actions/upload-artifact@v4
        with:
          name: whisper-server-linux-x64-cpu-ivybridge
          path: dist/whisper-server-linux-x64-cpu-ivybridge.zip

      - name: Upload whisper-server Sandy Bridge-level artifact
        uses: actions/upload-artifact@v4
        with:
          name: whisper-server-linux-x64-cpu-sandybridge
          path: dist/whisper-server-linux-x64-cpu-sandybridge.zip
```

- [ ] **Step 6: Release files and notes**

In "Prepare release files", replace:

```bash
          mv artifacts/whisper-server-linux-x64-vulkan/whisper-server-linux-x64-vulkan.zip release/
          ls -la release/
```

with:

```bash
          mv artifacts/whisper-server-linux-x64-vulkan/whisper-server-linux-x64-vulkan.zip release/
          for level in ivybridge sandybridge; do
            mv "artifacts/whisper-server-win32-x64-cpu-$level/whisper-server-win32-x64-cpu-$level.zip" release/
            mv "artifacts/whisper-server-linux-x64-cpu-$level/whisper-server-linux-x64-cpu-$level.zip" release/
          done
          ls -la release/
```

In the release body, replace:

```yaml
            - `whisper-server-linux-x64-vulkan.zip` - Linux x64 with Vulkan (uses system Vulkan loader)

            ## Requirements
```

with:

```yaml
            - `whisper-server-linux-x64-vulkan.zip` - Linux x64 with Vulkan (uses system Vulkan loader)
            - `whisper-server-win32-x64-cpu-ivybridge.zip`, `whisper-server-linux-x64-cpu-ivybridge.zip` - CPU-only, for processors with AVX and F16C but no AVX2 (Intel Ivy Bridge; AMD Piledriver, Steamroller, Jaguar)
            - `whisper-server-win32-x64-cpu-sandybridge.zip`, `whisper-server-linux-x64-cpu-sandybridge.zip` - CPU-only, for processors with AVX but no F16C (Intel Sandy Bridge; AMD Bulldozer)

            ## CPU requirements (x64)
            - Every x64 build without a level suffix needs AVX2, FMA, F16C and BMI2 (Intel Haswell, AMD Excavator or newer).
            - `-ivybridge` builds need SSE4.2, AVX and F16C. `-sandybridge` builds need SSE4.2 and AVX.

            ## Requirements
```

- [ ] **Step 7: Lint and parse**

```bash
/tmp/wf-venv/bin/actionlint .github/workflows/build-binaries.yml
python3 -c "import yaml,sys; wf=yaml.safe_load(open('.github/workflows/build-binaries.yml')); print(sorted(wf['jobs']))"
```

Expected: only the softprops finding. The job list is unchanged (F3 adds `verify-cpu-levels`).

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/build-binaries.yml
git commit -m "build: whisper-server for Ivy Bridge- and Sandy Bridge-level processors"
```

### Task F3: Run each build on its emulated processor

**Files:**
- Create: `.github/scripts/verify-cpu-levels.py`
- Modify: `.github/workflows/build-binaries.yml` (a new `verify-cpu-levels` job before `create-release`; `create-release.needs`)

**Interfaces:**
- Consumes: F2's artifacts, `samples/jfk.wav`.
- Produces: the CI gate `verify-cpu-levels` (matrix win32/sde and linux/qemu), which `create-release` needs. The logs go to the artifacts `verify-cpu-levels-{win32,linux}-logs`. CLI: `verify-cpu-levels.py --emulator {sde,qemu,none} --primary-zip Z --ivybridge-zip Z --sandybridge-zip Z [--with-llama-libraries] --work DIR`, exit 0 only when every check passes.

- [ ] **Step 1: Create the script**

`.github/scripts/verify-cpu-levels.py`:

```python
#!/usr/bin/env python3
"""Check whisper-server's builds for processors without AVX2 (OpenWhispr/openwhispr#2356).

Each build runs under an emulator that implements only its CPU level: Intel SDE
(-ivb, -snb) on Windows, QEMU user mode (-cpu IvyBridge, -cpu SandyBridge) on
Linux. The levels are upstream ggml's CPU variants:

  ivybridge    SSE4.2 + AVX + F16C (Intel Ivy Bridge, AMD Piledriver, Jaguar)
  sandybridge  SSE4.2 + AVX        (Intel Sandy Bridge, AMD Bulldozer)

1. Each build starts the way OpenWhispr starts it (a real model, Silero VAD on),
   transcribes samples/jfk.wav, and reports exactly its level's instruction sets.
2. The next build up must be stopped by the same emulator before it starts
   serving: the primary (AVX2) build on Ivy Bridge, the ivybridge build on Sandy
   Bridge. That proves the emulator enforces the level, so check 1 means
   something. It also proves what OpenWhispr's fallback relies on: a build dies
   at startup on a processor it does not support, not later mid-transcription.

--with-llama-libraries also starts the ivybridge build with llama.cpp's
libraries beside it, as in OpenWhispr's resources/bin: whisper-server loads
every ggml library in its folder at startup (ggml_backend_load_all).

--emulator none runs everything natively. It exists to smoke-test this script
locally and can never pass: nothing stops the rejection checks.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
AUDIO = REPO / "samples" / "jfk.wav"
EXPECTED_WORDS = "ask not what your country can do for you"

DOWNLOADS = {
    # models/README.md lists sha1 bd577a113a864445d4c299885e0cb97d4ba92b5f for this file
    "model": (
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    ),
    # The Silero VAD model OpenWhispr ships for its whisper-server
    "vad": (
        "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
        "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
    ),
    # Intel SDE 9.58. Intel's download mirror refuses non-browser clients; this
    # mirror serves the identical file (oven-sh/bun pins the same sha256).
    "sde": (
        "https://github.com/petarpetrovt/setup-sde/releases/download/binaries/"
        "sde-external-9.58.0-2025-06-16-win.tar.xz",
        "ebb8b3b63fcb0b6c1f9721118ba4883703d2aed9e0db2defed4e44fba78d9ca9",
    ),
    # The llama.cpp CPU builds OpenWhispr bundles (LLAMA_CPP_TAG in its
    # scripts/download-llama-server.js); used by --with-llama-libraries
    "llama-win32": (
        "https://github.com/ggml-org/llama.cpp/releases/download/b9763/"
        "llama-b9763-bin-win-cpu-x64.zip",
        "05144ee4d885a778ebaef619f79ca0b8a4edb7f017eaf70086a8781ff003815f",
    ),
    "llama-linux": (
        "https://github.com/ggml-org/llama.cpp/releases/download/b9763/"
        "llama-b9763-bin-ubuntu-x64.tar.gz",
        "4bd11fe0cea35223b240496062900ed9493b46f20a08747d431bfdc2252af2d8",
    ),
}

EMULATED_CPUS = {
    "ivybridge": {"sde": "-ivb", "qemu": "IvyBridge"},
    "sandybridge": {"sde": "-snb", "qemu": "SandyBridge"},
}
# What each build's system_info line must report, among the instruction sets that matter here
EXPECTED_FEATURES = {"ivybridge": {"AVX", "F16C"}, "sandybridge": {"AVX"}}
CHECKED_FEATURES = {"AVX", "AVX2", "F16C", "FMA", "BMI2", "AVX512"}
# The libraries OpenWhispr copies out of the llama.cpp archive (copyLibraries there)
LIBRARY = re.compile(r"\.(dll|so(\.\d+)*)$")

SDE_VIOLATION = re.compile(r"SDE-ERROR:.*not valid for specified chip.*", re.IGNORECASE)
READY_TIMEOUT_S = 900
INFERENCE_TIMEOUT_S = 2700


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(name, work):
    url, expected = DOWNLOADS[name]
    dest = work / url.rsplit("/", 1)[-1]
    if not dest.exists() or sha256_of(dest) != expected:
        print(f"Downloading {url}", flush=True)
        with urllib.request.urlopen(url, timeout=120) as response, open(dest, "wb") as out:
            shutil.copyfileobj(response, out)
    actual = sha256_of(dest)
    if actual != expected:
        raise SystemExit(f"{dest.name}: sha256 {actual}, expected {expected}")
    return dest


def extract(archive, dest):
    shutil.rmtree(dest, ignore_errors=True)
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            z.extractall(dest)
        return
    with tarfile.open(archive) as t:
        if hasattr(tarfile, "data_filter"):
            t.extractall(dest, filter="data")
        else:
            t.extractall(dest)


def unpack_server(zip_path, dest):
    """Extract a release zip and return the one whisper-server executable in it."""
    extract(zip_path, dest)
    servers = [p for p in dest.iterdir() if p.name.startswith("whisper-server")]
    if len(servers) != 1:
        raise SystemExit(f"{zip_path.name}: expected one whisper-server, found {servers}")
    servers[0].chmod(0o755)  # zipfile drops the executable bit
    return servers[0]


def with_llama_libraries(server, work):
    """Copy a build's folder and llama.cpp's libraries into one folder, flat,
    the way OpenWhispr lays out resources/bin. Returns the copied server."""
    archive = fetch("llama-win32" if os.name == "nt" else "llama-linux", work)
    extract(archive, work / "llama")
    dest = work / "with-llama"
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir()
    for path in (work / "llama").rglob("*"):
        if path.is_file() and LIBRARY.search(path.name):
            shutil.copy2(path, dest / path.name)
    for path in server.parent.iterdir():
        shutil.copy2(path, dest / path.name)
    return dest / server.name


def emulator(kind, cpu, work):
    """Return (command prefix, working directory) that runs a program on `cpu`."""
    if kind == "sde":
        root = work / "sde"
        if not root.exists():
            extract(fetch("sde", work), root)
        sde = next(root.glob("sde-external-*/sde.exe"))
        # SDE must run from its own directory to find Pin's DLLs
        return [str(sde), EMULATED_CPUS[cpu]["sde"], "--"], sde.parent
    if kind == "qemu":
        return ["qemu-x86_64", "-cpu", EMULATED_CPUS[cpu]["qemu"]], None
    return [], None


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(prefix, cwd, server, model, vad_model, log_path):
    """Start whisper-server with the arguments OpenWhispr passes (buildWhisperServerArgs)."""
    port = free_port()
    args = [str(server), "--model", str(model), "--host", "127.0.0.1", "--port", str(port)]
    args += ["--language", "auto", "--max-len", "4096"]
    if vad_model:
        args += ["--vad", "--vad-model", str(vad_model)]
    log = open(log_path, "wb")
    proc = subprocess.Popen(prefix + args, cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
    return proc, log, port


def wait_ready(proc, port):
    deadline = time.monotonic() + READY_TIMEOUT_S
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5):
                return True
        except urllib.error.HTTPError:
            return True  # any HTTP answer means it is up, as OpenWhispr's health check treats it
        except OSError:
            time.sleep(1)
    return False


def transcribe(port):
    """POST samples/jfk.wav to /inference with the fields OpenWhispr sends."""
    boundary = uuid.uuid4().hex
    fields = {
        "language": "auto",
        "entropy_thold": "2.8",
        "logprob_thold": "-1.25",
        "response_format": "json",
    }
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        for k, v in fields.items()
    ]
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"jfk.wav\"\r\n"
        "Content-Type: audio/wav\r\n\r\n".encode()
        + AUDIO.read_bytes()
        + f"\r\n--{boundary}--\r\n".encode()
    )
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/inference",
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=INFERENCE_TIMEOUT_S) as response:
        return json.loads(response.read())["text"]


def stop(proc):
    if proc.poll() is None:
        if os.name == "nt":
            # SDE runs the server as a child process; /T ends the whole tree
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        else:
            proc.terminate()
    try:
        proc.wait(timeout=60)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def violation(kind, returncode, output):
    """The emulator's verdict that the program ran an instruction the emulated CPU lacks."""
    if kind == "sde":
        match = SDE_VIOLATION.search(output)
        return match.group(0).strip() if match else None
    if kind == "qemu" and returncode == -signal.SIGILL:
        return "killed by SIGILL"
    return None


def reported_features(output):
    """Instruction sets the build says it was compiled for (its system_info line)."""
    for line in output.splitlines():
        if line.startswith("system_info:") and "CPU :" in line:
            enabled = re.findall(r"(\w+) = 1", line.split("CPU :", 1)[1])
            return set(enabled) & CHECKED_FEATURES
    return None


def words(text):
    return " ".join(re.sub(r"[^a-z]+", " ", text.lower()).split())


def run(kind, level, server, model, vad_model, work, label, transcribe_audio):
    """Start `server` on an emulated `level` processor. Returns (ready, text, output, returncode)."""
    prefix, cwd = emulator(kind, level, work)
    log_path = work / f"{label.replace(' ', '-')}.log"
    proc, log, port = start_server(prefix, cwd, server, model, vad_model, log_path)
    ready, text = False, None
    try:
        ready = wait_ready(proc, port)
        if ready and transcribe_audio:
            text = transcribe(port)
    finally:
        stop(proc)
        log.close()
    return ready, text, log_path.read_text(errors="replace"), proc.returncode


def check_transcribes(kind, level, server, model, vad_model, work):
    label = f"{server.name} on {level}"
    ready, text, output, returncode = run(kind, level, server, model, vad_model, work, label, True)
    hit = violation(kind, returncode, output)
    if hit:
        return False, f"{label} ran an instruction {level} lacks: {hit}"
    if not ready or text is None:
        return False, f"{label} did not start (exit {returncode}):\n{output[-2000:]}"
    if EXPECTED_WORDS not in words(text):
        return False, f"{label} transcribed jfk.wav as {text!r}"
    features = reported_features(output)
    if features != EXPECTED_FEATURES[level]:
        expected = sorted(EXPECTED_FEATURES[level])
        return False, f"{label} reports {sorted(features or [])}, expected {expected}"
    return True, f"{label}: transcribed {text.strip()!r}, reports {sorted(features)}"


def check_rejected(kind, level, server, model, work):
    label = f"{server.name} on {level}"
    ready, _, output, returncode = run(kind, level, server, model, None, work, label, False)
    if ready:
        return False, (
            f"{label} started serving. Either the emulator does not enforce {level} (then the "
            "transcription checks prove nothing) or the build no longer dies at startup on a "
            "processor it does not support (then OpenWhispr's fallback cannot see the crash)"
        )
    hit = violation(kind, returncode, output)
    if not hit:
        return False, f"{label} exited ({returncode}) without an instruction violation"
    return True, f"{label}: stopped at startup as expected ({hit})"


def check_starts_with_llama(kind, server, model, work):
    label = f"{server.name} with llama.cpp libraries on ivybridge"
    ready, _, output, returncode = run(kind, "ivybridge", server, model, None, work, label, False)
    hit = violation(kind, returncode, output)
    if hit:
        return False, f"{label} ran an instruction ivybridge lacks: {hit}"
    if not ready:
        return False, f"{label} did not start (exit {returncode}):\n{output[-2000:]}"
    return True, f"{label}: started"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--emulator", choices=["sde", "qemu", "none"], required=True)
    parser.add_argument("--primary-zip", type=Path, required=True)
    parser.add_argument("--ivybridge-zip", type=Path, required=True)
    parser.add_argument("--sandybridge-zip", type=Path, required=True)
    parser.add_argument("--with-llama-libraries", action="store_true")
    parser.add_argument("--work", type=Path, required=True)
    args = parser.parse_args()

    work = args.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    model, vad_model = fetch("model", work), fetch("vad", work)
    primary = unpack_server(args.primary_zip.resolve(), work / "primary")
    ivybridge = unpack_server(args.ivybridge_zip.resolve(), work / "ivybridge")
    sandybridge = unpack_server(args.sandybridge_zip.resolve(), work / "sandybridge")

    kind = args.emulator
    results = [
        check_transcribes(kind, "ivybridge", ivybridge, model, vad_model, work),
        check_transcribes(kind, "sandybridge", sandybridge, model, vad_model, work),
        check_rejected(kind, "ivybridge", primary, model, work),
        check_rejected(kind, "sandybridge", ivybridge, model, work),
    ]
    if args.with_llama_libraries:
        results.append(check_starts_with_llama(kind, with_llama_libraries(ivybridge, work), model, work))
    for ok, message in results:
        print(f"{'PASS' if ok else 'FAIL'}: {message}", flush=True)
    sys.exit(0 if all(ok for ok, _ in results) else 1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Smoke-test the script locally (macOS; x86_64 builds run under Rosetta)**

This proves the mechanics: downloads, unzip, server start, the multipart request, the text and `system_info` checks, and that the rejection checks fail without an emulator. It takes ~10 minutes, most of it building. Run it in bash: zsh does not split `$common` into words.

```bash
bash <<'EOF'
set -e
python3 -m venv /tmp/cmake-venv && /tmp/cmake-venv/bin/pip install -q cmake ninja
export PATH=/tmp/cmake-venv/bin:$PATH
SRC=~/dev/openwhispr-whisper-cpp-2356 W=/tmp/cpu-levels-smoke && mkdir -p $W
common="-G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.3 -DWHISPER_METAL=OFF -DGGML_METAL=OFF -DGGML_BLAS=OFF -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF"
cmake -S $SRC -B $W/primary $common >/dev/null
cmake -S $SRC -B $W/ivybridge $common -DGGML_SSE42=ON -DGGML_AVX=ON -DGGML_F16C=ON -DGGML_FMA=OFF -DGGML_BMI2=OFF -DGGML_AVX2=OFF | grep "Adding CPU backend variant"
cmake -S $SRC -B $W/sandybridge $common -DGGML_SSE42=ON -DGGML_AVX=ON -DGGML_F16C=OFF -DGGML_FMA=OFF -DGGML_BMI2=OFF -DGGML_AVX2=OFF | grep "Adding CPU backend variant"
for b in primary ivybridge sandybridge; do cmake --build $W/$b --target whisper-server -j 8 >/dev/null; done
cd $W && for b in primary ivybridge sandybridge; do n=whisper-server-darwin-x64-cpu$([ $b = primary ] || echo "-$b"); cp $b/bin/whisper-server $n && zip -q $b.zip $n && rm $n; done
cd $SRC && python3 .github/scripts/verify-cpu-levels.py --emulator none --primary-zip $W/primary.zip --ivybridge-zip $W/ivybridge.zip --sandybridge-zip $W/sandybridge.zip --with-llama-libraries --work $W/work || echo "exit=$?"
EOF
```

Expected: the two `grep` lines print the Linux ivybridge and sandybridge lines from Global Constraints. Then:

```
PASS: whisper-server-darwin-x64-cpu-ivybridge on ivybridge: transcribed 'And so my fellow Americans ask not what your country can do for you, ask what you can do for your country.', reports ['AVX', 'F16C']
PASS: whisper-server-darwin-x64-cpu-sandybridge on sandybridge: transcribed '…', reports ['AVX']
FAIL: whisper-server-darwin-x64-cpu on ivybridge started serving. Either the emulator does not enforce ivybridge …
FAIL: whisper-server-darwin-x64-cpu-ivybridge on sandybridge started serving. …
PASS: whisper-server-darwin-x64-cpu-ivybridge with llama.cpp libraries on ivybridge: started
exit=1
```

The two FAILs are the point: without an emulator nothing enforces a level, and the script must refuse to pass. The llama check is mechanical only on macOS, which cannot load Linux `.so` files.

- [ ] **Step 3: Add the verify job and gate the release on it**

Replace:

```yaml
  create-release:
    if: github.event_name != 'pull_request'
    needs: [build-macos-arm64, build-macos-x64, build-windows-x64-cpu, build-windows-x64-cuda, build-windows-x64-vulkan, build-linux-x64-cpu, build-linux-x64-cuda, build-linux-x64-vulkan]
```

with:

```yaml
  verify-cpu-levels:
    # Runs the ivybridge and sandybridge builds on emulated processors of exactly
    # those levels and checks the next build up is stopped at startup there. See
    # .github/scripts/verify-cpu-levels.py. create-release waits for this.
    needs: [build-windows-x64-cpu, build-linux-x64-cpu]
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: win32
            os: windows-2022
            emulator: sde
          - platform: linux
            # QEMU emulates AVX from 7.2 on; ubuntu-22.04 ships 6.2
            os: ubuntu-24.04
            emulator: qemu
    runs-on: ${{ matrix.os }}
    timeout-minutes: 120
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install QEMU user-mode emulation
        if: matrix.emulator == 'qemu'
        run: |
          sudo apt-get update
          sudo apt-get install -y qemu-user
          qemu-x86_64 --version

      - name: Download the CPU builds
        uses: actions/download-artifact@v4
        with:
          pattern: whisper-server-${{ matrix.platform }}-x64-cpu*
          path: artifacts

      - name: Run each build on its emulated processor
        shell: bash
        run: |
          base="artifacts/whisper-server-${{ matrix.platform }}-x64-cpu"
          python .github/scripts/verify-cpu-levels.py \
            --emulator ${{ matrix.emulator }} \
            --primary-zip "$base/whisper-server-${{ matrix.platform }}-x64-cpu.zip" \
            --ivybridge-zip "$base-ivybridge/whisper-server-${{ matrix.platform }}-x64-cpu-ivybridge.zip" \
            --sandybridge-zip "$base-sandybridge/whisper-server-${{ matrix.platform }}-x64-cpu-sandybridge.zip" \
            --with-llama-libraries \
            --work "$RUNNER_TEMP/verify-cpu-levels"

      - name: Upload the server logs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: verify-cpu-levels-${{ matrix.platform }}-logs
          path: ${{ runner.temp }}/verify-cpu-levels/*.log

  create-release:
    if: github.event_name != 'pull_request'
    needs: [build-macos-arm64, build-macos-x64, build-windows-x64-cpu, build-windows-x64-cuda, build-windows-x64-vulkan, build-linux-x64-cpu, build-linux-x64-cuda, build-linux-x64-vulkan, verify-cpu-levels]
```

- [ ] **Step 4: Lint and check the job graph**

```bash
/tmp/wf-venv/bin/actionlint .github/workflows/build-binaries.yml
python3 - <<'EOF'
import yaml
wf = yaml.safe_load(open(".github/workflows/build-binaries.yml"))
for name, job in wf["jobs"].items():
    print(f"{name:26s} if={job.get('if', '-'):38s} needs={job.get('needs', '-')} perms={job.get('permissions', '-')}")
EOF
```

Expected: only the softprops finding. `if=github.event_name != 'pull_request'` on the two macOS jobs, the four GPU jobs and create-release. create-release needs `verify-cpu-levels` and holds `{'contents': 'write'}`. No other job has permissions.

- [ ] **Step 5: Commit, push, open the draft PR**

```bash
git add .github/scripts/verify-cpu-levels.py .github/workflows/build-binaries.yml
git commit -m "ci: run the ivybridge and sandybridge builds on emulated processors"
git push -u origin build/whisper-server-cpu-levels
gh pr create --repo OpenWhispr/whisper.cpp --base master --head build/whisper-server-cpu-levels --draft \
  --title "build: whisper-server for processors without AVX2 (ivybridge, sandybridge)" \
  --body-file /tmp/fork-pr-body.md
```

Write the body (outline under "PRs" below) to `/tmp/fork-pr-body.md` first. Check that the PR's URL is under `OpenWhispr/whisper.cpp/pull/`.

- [ ] **Step 6: Read the evidence from the PR run**

```bash
RUN=$(gh run list --repo OpenWhispr/whisper.cpp --branch build/whisper-server-cpu-levels --workflow build-binaries.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN --repo OpenWhispr/whisper.cpp --exit-status
gh run view $RUN --repo OpenWhispr/whisper.cpp --log | grep -E "Adding CPU backend variant|^.*(PASS|FAIL): |SDE-ERROR"
gh run download $RUN --repo OpenWhispr/whisper.cpp -p 'whisper-server-*-cpu-*' -D /tmp/cpu-levels-artifacts
```

Expected: the configure lines from Global Constraints (primary unchanged). Then per platform, 6 PASS lines. The two rejection lines name the violation, for example `stopped at startup as expected (TID 0 SDE-ERROR: Executed instruction not valid for specified chip (IVYBRIDGE): … shlx …)` on Windows, and `(killed by SIGILL)` on Linux. The jobs `build-macos-*`, `build-*-cuda`, `build-*-vulkan` and `create-release` show "skipped". Paste the PASS lines and the run link into the PR body.

If the Windows leg reports an SDE violation inside a Windows system DLL (the `Image:` line after `SDE-ERROR` names it) rather than in whisper-server, the chip check is flagging the runner's own OS. Report that on the PR instead of loosening the check.

---

## Part D — OpenWhispr/openwhispr

### Task D1: Name the signal when whisper-server dies at startup

**Files:**
- Modify: `src/helpers/whisperServer.js` (helper after `getThreadSignature`, lines 119-121; `_doStart` lines 643-673; `waitForReady` line 782)
- Create: `test/helpers/whisperServerCpuFallback.test.js`

**Interfaces:**
- Produces: `describeProcessExit({ exitCode, signal }) -> string` (module-private), and inside `_doStart`, `getProcessInfo() -> { stderr: string, exitCode: number|null, signal: string|null }` and `startupTimeoutMs`. D2 uses the first two. The names and lines match open PR #2317.

- [ ] **Step 1: Write the failing test**

Create `test/helpers/whisperServerCpuFallback.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperServerManager = require("../../src/helpers/whisperServer");

// A Unix signal death reports no exit code, so a whisper-server killed by SIGILL
// at startup used to fail with no detail at all (#2356).
test("a startup death names the signal when the server printed nothing", async () => {
  const manager = new WhisperServerManager();

  await assert.rejects(
    manager.waitForReady(() => ({ stderr: "", exitCode: null, signal: "SIGSEGV" }), 1000),
    { message: "whisper-server process died during startup: signal: SIGSEGV" }
  );
  await assert.rejects(
    manager.waitForReady(() => ({ stderr: "", exitCode: 3221225501, signal: null }), 1000),
    { message: "whisper-server process died during startup: exit code: 3221225501" }
  );
  await assert.rejects(
    manager.waitForReady(
      () => ({ stderr: "ggml_abort\n", exitCode: null, signal: "SIGABRT" }),
      1000
    ),
    { message: "whisper-server process died during startup: ggml_abort" }
  );
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --test test/helpers/whisperServerCpuFallback.test.js`
Expected: FAIL, with actual message `'whisper-server process died during startup'` where `'…: signal: SIGSEGV'` was expected.

- [ ] **Step 3: Implement**

In `src/helpers/whisperServer.js`, directly above `function isVadActive(options = {}) {`, add:

```js
// How a process ended, as the startup errors report it. A Unix signal death has
// no exit code, so without the signal a SIGILL left no detail at all (#2356).
function describeProcessExit({ exitCode = null, signal = null } = {}) {
  if (signal) return `signal: ${signal}`;
  if (exitCode !== null) return `exit code: ${exitCode}`;
  return "";
}
```

In `_doStart`, replace:

```js
    let stderrBuffer = "";
    let exitCode = null;
```

with:

```js
    let stderrBuffer = "";
    let exitCode = null;
    let exitSignal = null;
    const getProcessInfo = () => ({ stderr: stderrBuffer, exitCode, signal: exitSignal });
```

Replace:

```js
    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("whisper-server process exited", { code });
```

with:

```js
    this.process.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      debugLogger.debug("whisper-server process exited", { code, signal });
```

Replace:

```js
    try {
      await this.waitForReady(
        () => ({ stderr: stderrBuffer, exitCode }),
        usingVulkan ? VULKAN_STARTUP_TIMEOUT_MS : STARTUP_TIMEOUT_MS
      );
```

with (PR #2317's exact lines, so git merges the two identical edits without a conflict):

```js
    const startupTimeoutMs = usingVulkan ? VULKAN_STARTUP_TIMEOUT_MS : STARTUP_TIMEOUT_MS;
    try {
      await this.waitForReady(getProcessInfo, startupTimeoutMs);
```

In `waitForReady`, replace:

```js
        const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
```

with:

```js
        const details = stderr || describeProcessExit(info);
```

- [ ] **Step 4: Run the new test and the existing server tests**

Run: `node --import tsx --test test/helpers/whisperServerCpuFallback.test.js test/helpers/whisperServerGpuGuard.test.js test/helpers/whisperCudaRequestFallback.test.js test/helpers/whisperServerVadArgs.test.js test/helpers/whisperServerWavInput.test.js test/helpers/whisperServerInferenceFields.test.js`
Expected: `ℹ pass 60`, `ℹ fail 0`.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write src/helpers/whisperServer.js test/helpers/whisperServerCpuFallback.test.js
git add src/helpers/whisperServer.js test/helpers/whisperServerCpuFallback.test.js
git commit -m "fix(whisper): name the signal when whisper-server dies at startup"
```

### Task D2: Fall back to whisper-server builds for processors without AVX2

**Files:**
- Modify: `src/helpers/whisperCppRelease.js`
- Modify: `src/helpers/whisperServer.js` (require block line 15; helpers after D1's `describeProcessExit`; a method after `getServerBinaryPath`, line 448; `_doStart`'s catch between the GPU branch (ends line 694) and the thread branch; `module.exports`)
- Replace: `test/helpers/whisperServerCpuFallback.test.js`
- Modify: `CLAUDE.md` (line 228), `TROUBLESHOOTING.md` (line 103)

**Interfaces:**
- Consumes: D1's `describeProcessExit`, `getProcessInfo`.
- Produces:
  - `whisperCppRelease.CPU_FALLBACK_LEVELS: readonly ["ivybridge", "sandybridge"]`
  - `whisperCppRelease.cpuFallbackServerBinaryName(platform: string, arch: string, level: string) -> string`, for example `("win32", "x64", "ivybridge") -> "whisper-server-win32-x64-ivybridge.exe"` and `("linux", "x64", "sandybridge") -> "whisper-server-linux-x64-sandybridge"`
  - `WhisperServerManager.isIllegalInstructionExit({ exitCode, signal }) -> boolean` (module export)
  - `WhisperServerManager#getCpuFallbackBinaryPath(binary: string) -> string | null`
  - D3 and D4 use the two `whisperCppRelease` exports.

- [ ] **Step 1: Add the level names (no behaviour yet)**

Replace `src/helpers/whisperCppRelease.js` with:

```js
const WHISPER_CPP_TAG = process.env.WHISPER_CPP_VERSION || "0.0.10";

const WINDOWS_MSVC_RUNTIME_LIBRARIES = Object.freeze([
  "msvcp140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "vcomp140.dll",
]);

// CPU builds for processors without AVX2, which whisperServer.js falls back to
// in this order when a build dies of an illegal instruction (#2356). The names
// are upstream ggml's CPU levels:
//   ivybridge    SSE4.2 + AVX + F16C: Intel Ivy Bridge, AMD Piledriver, Steamroller, Jaguar
//   sandybridge  SSE4.2 + AVX: Intel Sandy Bridge, AMD Bulldozer
// ivybridge comes first because F16C matters: without it every fp16 weight is
// converted through a lookup table, and transcription runs several times slower.
const CPU_FALLBACK_LEVELS = Object.freeze(["ivybridge", "sandybridge"]);

function cpuFallbackServerBinaryName(platform, arch, level) {
  return `whisper-server-${platform}-${arch}-${level}${platform === "win32" ? ".exe" : ""}`;
}

module.exports = {
  WHISPER_CPP_TAG,
  WINDOWS_MSVC_RUNTIME_LIBRARIES,
  CPU_FALLBACK_LEVELS,
  cpuFallbackServerBinaryName,
};
```

- [ ] **Step 2: Write the failing tests**

Replace `test/helpers/whisperServerCpuFallback.test.js` with:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installElectronStub, setUserDataDir } = require("./harness/electronStub");

// getServerBinaryPath's GPU branch and sidecarPidFile read app.getPath("userData").
// Each install below points it at its own temp dir, so no pid file lands in the repo.
installElectronStub();

const WhisperServerManager = require("../../src/helpers/whisperServer");
const { isIllegalInstructionExit } = WhisperServerManager;
const { BIN_SUBDIR: CUDA_BIN_SUBDIR } = require("../../src/helpers/whisperCudaManager");
const { cpuFallbackServerBinaryName } = require("../../src/helpers/whisperCppRelease");

const PRIMARY = `whisper-server-${process.platform}-${process.arch}`;
const IVYBRIDGE = cpuFallbackServerBinaryName(process.platform, process.arch, "ivybridge");
const SANDYBRIDGE = cpuFallbackServerBinaryName(process.platform, process.arch, "sandybridge");
const CUDA = `whisper-server-${process.platform}-${process.arch}-cuda`;

// The fake builds are POSIX shell scripts. CI runs this suite on Linux; the
// Windows exit code is covered by the isIllegalInstructionExit test.
const POSIX_ONLY =
  process.platform === "win32" && "the fake whisper-server builds are shell scripts";

// A temp install: fake whisper-server builds in <dir>/bin, found through
// process.resourcesPath like a packaged app, and a CUDA pack under <dir>/userData.
// Each fake appends its file name to spawns.log, then either dies of a signal
// ("sigill" is how a build dies on a processor that lacks its instructions) or
// serves HTTP like a started server. On macOS each signal death also leaves a
// crash report in ~/Library/Logs/DiagnosticReports.
function createInstall(t, builds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-cpu-fallback-"));
  const spawnLog = path.join(dir, "spawns.log");
  const serverScript = path.join(dir, "fake-server.js");
  fs.writeFileSync(
    serverScript,
    `const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
require("http")
  .createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "ok" }));
  })
  .listen(port, "127.0.0.1");
`
  );
  const dirs = {
    [PRIMARY]: path.join(dir, "bin"),
    [IVYBRIDGE]: path.join(dir, "bin"),
    [SANDYBRIDGE]: path.join(dir, "bin"),
    [CUDA]: path.join(dir, "userData", "bin", CUDA_BIN_SUBDIR),
  };
  const runs = {
    sigill: "kill -s ILL $$",
    sigsegv: "kill -s SEGV $$",
    serve: `exec '${process.execPath}' '${serverScript}' "$@"`,
  };
  for (const [name, behavior] of Object.entries(builds)) {
    fs.mkdirSync(dirs[name], { recursive: true });
    fs.writeFileSync(
      path.join(dirs[name], name),
      `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${spawnLog}'\n${runs[behavior]}\n`,
      { mode: 0o755 }
    );
  }
  const model = path.join(dir, "ggml-test.bin");
  fs.writeFileSync(model, "not a real model");

  const previousResourcesPath = process.resourcesPath;
  process.resourcesPath = dir;
  setUserDataDir(path.join(dir, "userData"));
  const manager = new WhisperServerManager();
  t.after(async () => {
    await manager.stop();
    process.resourcesPath = previousResourcesPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    manager,
    model,
    binaryPath: (name) => path.join(dirs[name], name),
    spawns: () =>
      fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, "utf8").split("\n").filter(Boolean) : [],
  };
}

// A Unix signal death reports no exit code, so a whisper-server killed by SIGILL
// at startup used to fail with no detail at all (#2356).
test("a startup death names the signal when the server printed nothing", async () => {
  const manager = new WhisperServerManager();

  await assert.rejects(
    manager.waitForReady(() => ({ stderr: "", exitCode: null, signal: "SIGSEGV" }), 1000),
    { message: "whisper-server process died during startup: signal: SIGSEGV" }
  );
  await assert.rejects(
    manager.waitForReady(() => ({ stderr: "", exitCode: 3221225501, signal: null }), 1000),
    { message: "whisper-server process died during startup: exit code: 3221225501" }
  );
  await assert.rejects(
    manager.waitForReady(
      () => ({ stderr: "ggml_abort\n", exitCode: null, signal: "SIGABRT" }),
      1000
    ),
    { message: "whisper-server process died during startup: ggml_abort" }
  );
});

test("isIllegalInstructionExit recognises the Windows and Unix illegal-instruction exits only", () => {
  // How Node reports STATUS_ILLEGAL_INSTRUCTION (0xC000001D) on Windows
  assert.equal(isIllegalInstructionExit({ exitCode: 3221225501, signal: null }), true);
  // The same NTSTATUS read as a signed 32-bit value (cmd's %ERRORLEVEL%)
  assert.equal(isIllegalInstructionExit({ exitCode: -1073741795, signal: null }), true);
  assert.equal(isIllegalInstructionExit({ exitCode: null, signal: "SIGILL" }), true);

  assert.equal(isIllegalInstructionExit({ exitCode: 3221225477, signal: null }), false); // access violation
  assert.equal(isIllegalInstructionExit({ exitCode: 1, signal: null }), false);
  assert.equal(isIllegalInstructionExit({ exitCode: 132, signal: null }), false); // a shell's 128 + 4
  assert.equal(isIllegalInstructionExit({ exitCode: null, signal: "SIGSEGV" }), false);
  assert.equal(isIllegalInstructionExit({ exitCode: null, signal: null }), false); // still running
  assert.equal(isIllegalInstructionExit({}), false);
});

test(
  "an Ivy Bridge-class processor: the primary dies of SIGILL and the ivybridge build takes over",
  { skip: POSIX_ONLY },
  async (t) => {
    const install = createInstall(t, {
      [PRIMARY]: "sigill",
      [IVYBRIDGE]: "serve",
      [SANDYBRIDGE]: "serve",
    });

    await install.manager.start(install.model, { threads: 4 });

    assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE]);
    assert.equal(install.manager.getStatus().running, true);
    assert.equal(install.manager.getServerBinaryPath(), install.binaryPath(IVYBRIDGE));
  }
);

test(
  "a Sandy Bridge-class processor: each build that dies hands over to the next level",
  { skip: POSIX_ONLY },
  async (t) => {
    const install = createInstall(t, {
      [PRIMARY]: "sigill",
      [IVYBRIDGE]: "sigill",
      [SANDYBRIDGE]: "serve",
    });

    await install.manager.start(install.model, { threads: 4 });

    assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE, SANDYBRIDGE]);
    assert.equal(install.manager.getServerBinaryPath(), install.binaryPath(SANDYBRIDGE));
  }
);

test("a level that is not installed is skipped", { skip: POSIX_ONLY }, async (t) => {
  const install = createInstall(t, { [PRIMARY]: "sigill", [SANDYBRIDGE]: "serve" });

  await install.manager.start(install.model, { threads: 4 });

  assert.deepEqual(install.spawns(), [PRIMARY, SANDYBRIDGE]);
});

test(
  "with no build for older processors installed, the crash is reported once and the thread retry is skipped",
  { skip: POSIX_ONLY },
  async (t) => {
    // 8 logical CPUs resolve to 6 auto threads: the case that used to relaunch
    // the same crashing build with the default thread count
    t.mock.method(os, "availableParallelism", () => 8);
    const install = createInstall(t, { [PRIMARY]: "sigill" });

    await assert.rejects(install.manager.start(install.model), (err) => {
      assert.match(err.message, /^whisper-server can't run on this processor: /);
      assert.match(err.message, new RegExp(`${PRIMARY} stopped on an instruction`));
      assert.match(err.message, /\(signal: SIGILL\)/);
      // ipcHandlers' transcribe-local-whisper maps these substrings to other errors
      assert.doesNotMatch(err.message, /whisper-cpp|FFmpeg|not downloaded|Audio buffer is empty/);
      return true;
    });
    assert.deepEqual(install.spawns(), [PRIMARY]);
  }
);

test(
  "when every build dies, each is launched once and later starts go straight to the last one",
  { skip: POSIX_ONLY },
  async (t) => {
    const install = createInstall(t, {
      [PRIMARY]: "sigill",
      [IVYBRIDGE]: "sigill",
      [SANDYBRIDGE]: "sigill",
    });

    await assert.rejects(install.manager.start(install.model, { threads: 4 }), (err) => {
      assert.match(err.message, new RegExp(`${SANDYBRIDGE} stopped on an instruction`));
      return true;
    });
    assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE, SANDYBRIDGE]);

    await assert.rejects(
      install.manager.start(install.model, { threads: 4 }),
      /can't run on this processor/
    );
    assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE, SANDYBRIDGE, SANDYBRIDGE]);
  }
);

test(
  "the switch outlives stop(): a later start never re-runs the build that crashed",
  { skip: POSIX_ONLY },
  async (t) => {
    const install = createInstall(t, { [PRIMARY]: "sigill", [IVYBRIDGE]: "serve" });

    await install.manager.start(install.model, { threads: 4 });
    await install.manager.stop();
    await install.manager.start(install.model, { threads: 4 });

    assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE, IVYBRIDGE]);
  }
);

test(
  "a CUDA pack on such a processor falls back to CPU, then down to the build that runs (#1613)",
  { skip: POSIX_ONLY },
  async (t) => {
    const install = createInstall(t, {
      [CUDA]: "sigill",
      [PRIMARY]: "sigill",
      [IVYBRIDGE]: "serve",
    });
    const fallbacks = [];
    install.manager.on("cuda-fallback", () => fallbacks.push("cuda"));

    await install.manager.start(install.model, { useCuda: true, threads: 4 });

    assert.deepEqual(install.spawns(), [CUDA, PRIMARY, IVYBRIDGE]);
    assert.deepEqual(fallbacks, ["cuda"]);
    assert.equal(install.manager.gpuFallbackActive, true);
    assert.equal(install.manager.getStatus().gpuBackend, null);

    // WHISPER_GPU_FAILED=cuda makes the next dictation resolve to CPU: it reuses this server
    await install.manager.start(install.model, { useCuda: false, useVulkan: false, threads: 4 });
    assert.equal(install.spawns().length, 3);
  }
);

test(
  "any other startup crash fails as before and keeps the primary build",
  { skip: POSIX_ONLY },
  async (t) => {
    const install = createInstall(t, { [PRIMARY]: "sigsegv", [IVYBRIDGE]: "serve" });

    await assert.rejects(install.manager.start(install.model, { threads: 4 }), {
      message: "whisper-server process died during startup: signal: SIGSEGV",
    });
    assert.deepEqual(install.spawns(), [PRIMARY]);
    assert.equal(install.manager.getServerBinaryPath(), install.binaryPath(PRIMARY));
  }
);

test("two starts racing through the switch share one fallback", { skip: POSIX_ONLY }, async (t) => {
  const install = createInstall(t, { [PRIMARY]: "sigill", [IVYBRIDGE]: "serve" });

  // Launch pre-warm and the first dictation arrive together
  await Promise.all([
    install.manager.start(install.model, { threads: 4 }),
    install.manager.start(install.model, { threads: 4 }),
  ]);

  assert.deepEqual(install.spawns(), [PRIMARY, IVYBRIDGE]);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --import tsx --test test/helpers/whisperServerCpuFallback.test.js`
Expected: 2 pass ("a startup death names the signal…" and "any other startup crash…", which must hold both before and after). 9 fail: the `isIllegalInstructionExit` test with `TypeError: isIllegalInstructionExit is not a function`, and the rest on `whisper-server process died during startup: signal: SIGILL`. The old code also relaunches the crashing build once through the thread retry. The "no build … installed" test would catch that in its spawn assertion, but its message assertion fails first.

These tests cannot produce the Windows exit code: on Unix an exit status is 8 bits, so 3221225501 can only arrive as a signal. The Windows path shares the same branch and differs only in `isIllegalInstructionExit`, which the pure test covers.

- [ ] **Step 4: Implement the fallback**

In `src/helpers/whisperServer.js`, after `const { BIN_SUBDIR: VULKAN_BIN_SUBDIR } = require("./whisperVulkanManager");` add:

```js
const { CPU_FALLBACK_LEVELS, cpuFallbackServerBinaryName } = require("./whisperCppRelease");
```

Directly below D1's `describeProcessExit`, add:

```js
// A process that executes an instruction its processor lacks is ended with
// STATUS_ILLEGAL_INSTRUCTION (0xC000001D) on Windows and SIGILL on Unix. The
// primary CPU build needs AVX2, FMA, F16C and BMI2, so this is how it dies at
// startup on Intel processors before Haswell and on AMD FX (#2356).
const STATUS_ILLEGAL_INSTRUCTION = 0xc000001d;

function isIllegalInstructionExit({ exitCode = null, signal = null } = {}) {
  if (signal === "SIGILL") return true;
  // Node reports the NTSTATUS unsigned (3221225501); >>> 0 also maps the signed form
  return Number.isInteger(exitCode) && exitCode >>> 0 === STATUS_ILLEGAL_INSTRUCTION;
}
```

Replace:

```js
  isAvailable() {
    return this.getServerBinaryPath() !== null;
  }
```

with:

```js
  // The CPU build to try after `binary` died of an illegal instruction: the
  // first CPU_FALLBACK_LEVELS build below it that is installed next to it, or
  // null when none is left. Only win32-x64 and linux-x64 ship these builds.
  getCpuFallbackBinaryPath(binary) {
    const names = CPU_FALLBACK_LEVELS.map((level) =>
      cpuFallbackServerBinaryName(process.platform, process.arch, level)
    );
    for (const name of names.slice(names.indexOf(path.basename(binary)) + 1)) {
      const candidate = path.join(path.dirname(binary), name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  isAvailable() {
    return this.getServerBinaryPath() !== null;
  }
```

In `_doStart`'s catch, replace:

```js
        return this._doStart(modelPath, { ...options, useCuda: false, useVulkan: false });
      }
      if (shouldFallbackToDefaultThreads(threadResolution)) {
```

with:

```js
        return this._doStart(modelPath, { ...options, useCuda: false, useVulkan: false });
      }
      // The CPU build ran an instruction this processor lacks: move one level
      // down (getCpuFallbackBinaryPath). Caching the build makes it the CPU
      // binary for the rest of the session, since stop() leaves the cache alone,
      // so later restarts and GPU fallbacks never re-run a build that crashed.
      // The process has already exited, so there is nothing for stop() to reap
      // and gpuFallbackActive stays as the GPU branch above left it. The thread
      // retry below is skipped: the same build would only crash again.
      const processInfo = getProcessInfo();
      if (isIllegalInstructionExit(processInfo)) {
        const exit = describeProcessExit(processInfo);
        const fallbackBinary = this.getCpuFallbackBinaryPath(serverBinary);
        if (fallbackBinary) {
          debugLogger.warn(
            "whisper-server stopped on an instruction this processor lacks, retrying with a build for older processors",
            { exit, from: path.basename(serverBinary), to: path.basename(fallbackBinary) }
          );
          this.cachedServerBinaryPath = fallbackBinary;
          return this._doStart(modelPath, options);
        }
        throw new Error(
          `whisper-server can't run on this processor: ${path.basename(serverBinary)} stopped on ` +
            `an instruction the processor doesn't support (${exit}), and no build for older ` +
            "processors is left to try"
        );
      }
      if (shouldFallbackToDefaultThreads(threadResolution)) {
```

At the end of the file, after `module.exports.shouldRetryAfterServerReplaced = shouldRetryAfterServerReplaced;`, add:

```js
module.exports.isIllegalInstructionExit = isIllegalInstructionExit;
```

What this does, and what it keeps as it was:
- The GPU branch stays first. A GPU pack is built with the same AVX2 flags, so on these CPUs it dies too; the GPU branch falls back to CPU, and the CPU path then walks the levels (the #1613 test).
- `start()`'s no-op guard is untouched. The switch changes no signature: `gpuSignature` stays `gpu:cpu`.
- Concurrent callers await the same `startupPromise`, and the retry recurses inside it.
- `isAvailable()`, `getStatus()` and `logDependencyStatus()` report the build in use, because they read `cachedServerBinaryPath`.
- The recursion keeps `options.threadResolution`. So if a fallback build then fails for a non-SIGILL reason, the existing thread retry still applies to that build.

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test test/helpers/whisperServerCpuFallback.test.js test/helpers/whisperServerGpuGuard.test.js test/helpers/whisperCudaRequestFallback.test.js test/helpers/whisperServerVadArgs.test.js test/helpers/whisperServerWavInput.test.js test/helpers/whisperServerInferenceFields.test.js`
Expected: `ℹ pass 70`, `ℹ fail 0` (11 new tests + 59 existing).

- [ ] **Step 6: Document it** (as executed, per A4: the CLAUDE.md entry without the platform sentence, and no TROUBLESHOOTING line; both land in D4 Step 3b)

In `CLAUDE.md`, under `### whisper.cpp Integration`, directly after this line (the first of two similar lines; this one is indented):

```markdown
  - Models stored in `~/.cache/openwhispr/whisper-models/`
```

add:

```markdown
- **whisperServer.js**: whisper-server process lifecycle and fallbacks
  - A CPU build that dies of an illegal instruction during startup (Windows exit code 3221225501 / 0xC000001D, Unix SIGILL: the AVX2 build on Intel before Haswell or AMD FX) is retried on the next installed build in `CPU_FALLBACK_LEVELS` (`whisperCppRelease.js`: `ivybridge` = SSE4.2 + AVX + F16C, then `sandybridge` = SSE4.2 + AVX, upstream ggml's level names), looked up next to the build that died. The build that starts becomes `cachedServerBinaryPath`, so every later CPU start in the session uses it; `stop()` never clears it. With none left, startup fails with "whisper-server can't run on this processor" and skips the thread-count retry. Shipped for win32-x64 and linux-x64 (#2356)
```

In `TROUBLESHOOTING.md`, replace:

```markdown
5. Try cloud transcription as fallback
```

with:

```markdown
5. Try cloud transcription as fallback
6. On processors without AVX2 (Intel before Haswell, AMD FX), the standard engine stops at startup (Windows exit code 3221225501, Linux SIGILL) and OpenWhispr switches to a build for older processors by itself, on Windows and Linux: transcription works, more slowly. If the error says whisper-server can't run on this processor, the processor also lacks AVX (for example first-generation Core i processors and many Celeron, Pentium and Atom models): use a cloud transcription provider instead.
```

It is one list line on purpose. PR #2317 rewrites the GPU paragraph two lines below, and a new paragraph there sits right next to that change and conflicts. This line keeps an unchanged blank line between the two edits: `git merge-file` against #2317's hunk merges it with no conflict.

- [ ] **Step 7: Format, lint, commit**

```bash
npx prettier --write src/helpers/whisperServer.js src/helpers/whisperCppRelease.js test/helpers/whisperServerCpuFallback.test.js CLAUDE.md TROUBLESHOOTING.md
git diff --stat   # CLAUDE.md and TROUBLESHOOTING.md: only the added lines
npm run lint
git add src/helpers/whisperServer.js src/helpers/whisperCppRelease.js test/helpers/whisperServerCpuFallback.test.js CLAUDE.md TROUBLESHOOTING.md
git commit -m "fix(whisper): fall back to whisper-server builds for processors without AVX2"
```

If Prettier rewraps unrelated lines in CLAUDE.md or TROUBLESHOOTING.md, revert those hunks (`git checkout -p`) and keep only the added lines.

### Task D3: Install every whisper-server build a platform lists

**Files:**
- Modify: `scripts/download-whisper-cpp.js` (BINARIES lines 21-49; `downloadBinary` lines 89-161; new functions before `downloadAllBinaries`; `main` lines 191-213; exports line 239)
- Modify: `test/scripts/downloadWhisperCpp.test.js` (imports lines 7-17; tests appended)

**Interfaces:**
- Produces:
  - `getEntriesForPlatformArch(platformArch: string, binaries = BINARIES) -> Array<[key, config]>`
  - `downloadCurrentPlatform(platformArch, release, isForce, { binaries = BINARIES, download = downloadBinary } = {}) -> Promise<boolean>`
  - every `BINARIES` entry carries `platformArch`
  - install markers are `.whisper-cpp-<entry key>.json`; the primary keys equal their platformArch, so today's markers keep their names
  - D4 adds entries only.

- [ ] **Step 1: Write the failing tests**

In `test/scripts/downloadWhisperCpp.test.js`, replace the two require blocks at the top with:

```js
const {
  cleanupFiles,
  copyLibraries,
  findLibrariesInDir,
  matchesPattern,
} = require("../../scripts/lib/download-utils");
const {
  BINARIES,
  WHISPER_CPP_TAG,
  downloadAllBinaries,
  downloadCurrentPlatform,
  getEntriesForPlatformArch,
  isCompleteInstall,
} = require("../../scripts/download-whisper-cpp");
```

Append:

```js
test("--current installs every build configured for the platform and fails if any is missing", async () => {
  const binaries = {
    "win32-x64": { platformArch: "win32-x64" },
    "win32-x64-ivybridge": { platformArch: "win32-x64" },
    "win32-x64-sandybridge": { platformArch: "win32-x64" },
    "linux-x64": { platformArch: "linux-x64" },
  };
  const attempts = [];
  const download = (failing) => async (key) => {
    attempts.push(key);
    return key !== failing;
  };

  // A release without one of the builds must fail the build, never ship without it
  assert.equal(
    await downloadCurrentPlatform("win32-x64", { assets: [] }, false, {
      binaries,
      download: download("win32-x64-ivybridge"),
    }),
    false
  );
  assert.deepEqual(attempts, ["win32-x64", "win32-x64-ivybridge"]);

  attempts.length = 0;
  assert.equal(
    await downloadCurrentPlatform("win32-x64", { assets: [] }, false, {
      binaries,
      download: download(null),
    }),
    true
  );
  assert.deepEqual(attempts, ["win32-x64", "win32-x64-ivybridge", "win32-x64-sandybridge"]);

  attempts.length = 0;
  assert.equal(
    await downloadCurrentPlatform("freebsd-x64", { assets: [] }, false, {
      binaries,
      download: download(null),
    }),
    false
  );
  assert.deepEqual(attempts, []);
});

test("every configured build installs under its platform's name, which CI cleanup keeps", () => {
  for (const [key, config] of Object.entries(BINARIES)) {
    assert.ok(key.startsWith(config.platformArch), key);
    assert.ok(config.outputName.startsWith(`whisper-server-${config.platformArch}`), key);
    assert.ok(
      getEntriesForPlatformArch(config.platformArch).some(([k]) => k === key),
      key
    );
  }
});

test("CI cleanup keeps the current platform's builds for processors without AVX2", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-cleanup-test-"));
  const files = [
    ".whisper-cpp-win32-x64.json",
    "msvcp140.dll",
    "whisper-server-linux-x64",
    "whisper-server-linux-x64-ivybridge",
    "whisper-server-win32-x64-ivybridge.exe",
    "whisper-server-win32-x64-sandybridge.exe",
    "whisper-server-win32-x64.exe",
  ];
  for (const name of files) fs.writeFileSync(path.join(tempDir, name), name);

  try {
    cleanupFiles(tempDir, "whisper-server", "whisper-server-win32-x64");
    assert.deepEqual(fs.readdirSync(tempDir).sort(), [
      ".whisper-cpp-win32-x64.json",
      "msvcp140.dll",
      "whisper-server-win32-x64-ivybridge.exe",
      "whisper-server-win32-x64-sandybridge.exe",
      "whisper-server-win32-x64.exe",
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --import tsx --test test/scripts/downloadWhisperCpp.test.js`
Expected: the first test fails with `TypeError: downloadCurrentPlatform is not a function`, and the second with a failed `assert.ok` because `config.platformArch` is undefined. The cleanup test already passes: it pins today's behaviour for the new names.

- [ ] **Step 3: Implement**

In `scripts/download-whisper-cpp.js`:

1. Above `const BINARIES = {`, after the line `// 0.0.10 is the first release whose win32 zips bundle the MSVC runtime DLLs (CUS-113).`, add:

```js
// Keyed by build; platformArch groups the builds one --current run installs. Every
// build of a platform is required: a release missing one must fail the build.
```

and add `platformArch: "<same as the key>",` as the first property of each of the four entries (`"darwin-arm64"`, `"darwin-x64"`, `"win32-x64"`, `"linux-x64"`).

2. In `downloadBinary`, rename the first parameter `platformArch` to `key`, and use `key` in all its log lines and in these two paths:

```js
  const installMarkerPath = path.join(BIN_DIR, `.whisper-cpp-${key}.json`);
```

```js
    const extractDir = path.join(BIN_DIR, `temp-whisper-${key}`);
```

After Prettier, the not-found branch becomes one line:

```js
      console.error(`  [server] ${key}: Binary "${config.binaryName}" not found in archive`);
```

3. Directly above `async function downloadAllBinaries(`, add:

```js
function getEntriesForPlatformArch(platformArch, binaries = BINARIES) {
  return Object.entries(binaries).filter(([, config]) => config.platformArch === platformArch);
}

async function downloadCurrentPlatform(
  platformArch,
  release,
  isForce,
  { binaries = BINARIES, download = downloadBinary } = {}
) {
  const entries = getEntriesForPlatformArch(platformArch, binaries);
  if (entries.length === 0) {
    console.error(`Unsupported platform/arch: ${platformArch}`);
    return false;
  }

  console.log(`Downloading for target platform (${platformArch}):`);
  for (const [key, config] of entries) {
    if (!(await download(key, config, release, isForce))) {
      console.error(`Failed to download binaries for ${key}`);
      return false;
    }
  }
  return true;
}
```

4. In `main()`, replace:

```js
  if (args.isCurrent) {
    if (!BINARIES[args.platformArch]) {
      console.error(`Unsupported platform/arch: ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Downloading for target platform (${args.platformArch}):`);
    const ok = await downloadBinary(
      args.platformArch,
      BINARIES[args.platformArch],
      release,
      args.isForce
    );
    if (!ok) {
      console.error(`Failed to download binaries for ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

```

with:

```js
  if (args.isCurrent) {
    if (!(await downloadCurrentPlatform(args.platformArch, release, args.isForce))) {
      process.exitCode = 1;
      return;
    }

```

5. Replace the export line with:

```js
module.exports = {
  BINARIES,
  WHISPER_CPP_TAG,
  downloadAllBinaries,
  downloadCurrentPlatform,
  getEntriesForPlatformArch,
  isCompleteInstall,
};
```

- [ ] **Step 4: Run the tests and a real download**

```bash
node --import tsx --test test/scripts/downloadWhisperCpp.test.js   # expect ℹ pass 11, ℹ fail 0
node scripts/download-whisper-cpp.js --current --platform linux --arch x64 --force
ls -a resources/bin | grep -E "whisper-(server|cpp)"
```

Expected: the download log shows `[server] linux-x64: Extracted to whisper-server-linux-x64`, and `resources/bin` holds `whisper-server-linux-x64` plus `.whisper-cpp-linux-x64.json`. Delete those two files afterwards (`resources/bin` is gitignored, but keep a dev machine's layout honest).

- [ ] **Step 5: Format, commit, push, open the draft PR**

```bash
npx prettier --write scripts/download-whisper-cpp.js test/scripts/downloadWhisperCpp.test.js
npm run lint && npm test
git add scripts/download-whisper-cpp.js test/scripts/downloadWhisperCpp.test.js
git commit -m "build(whisper): install every whisper-server build a platform lists"
git push -u origin fix/2356-no-avx2-cpu-fallback
gh pr create --repo OpenWhispr/openwhispr --base main --head fix/2356-no-avx2-cpu-fallback --draft \
  --title "fix(whisper): fall back to whisper-server builds for processors without AVX2" \
  --body-file /tmp/desktop-pr-body.md
```

If `npm test` shows failures only in `markdownRenderer`, `richTextEditor`, `assistantPanel`, `chatMessageApprovals` or `enterpriseIdentityStoreImports`, run those files on a clean checkout of origin/main. They fail identically there on a machine whose `node_modules` has drifted. Rely on CI's clean `npm ci` run.

### Task D4: Pin whisper.cpp 0.0.11 (blocked until Part R publishes 0.0.11)

**Files:**
- Modify: `src/helpers/whisperCppRelease.js` (line 1)
- Modify: `scripts/download-whisper-cpp.js` (require block, lines 14-17; the comment above BINARIES; entries after BINARIES)
- Modify: `src/helpers/whisperCudaManager.js`, `src/helpers/whisperVulkanManager.js` (EXPECTED_DIGESTS)
- Modify: `test/scripts/downloadWhisperCpp.test.js`, `test/helpers/gpuBinaryManager.test.js` (line 166)
- Modify: `src/utils/gpuDetection.js` (comment, line 6)

**Interfaces:**
- Consumes: D2's `CPU_FALLBACK_LEVELS` and `cpuFallbackServerBinaryName`; D3's per-build entries.
- Produces: `BINARIES["{win32,linux}-x64-{ivybridge,sandybridge}"]`, and `WHISPER_CPP_TAG === "0.0.11"`.

- [ ] **Step 1: Confirm the release and compute the GPU digests**

```bash
gh release view 0.0.11 --repo OpenWhispr/whisper.cpp --json assets --jq '.assets[].name' | sort
mkdir -p /tmp/wcpp-0.0.11 && cd /tmp/wcpp-0.0.11
gh release download 0.0.11 --repo OpenWhispr/whisper.cpp --clobber \
  -p 'whisper-server-win32-x64-cuda.zip' -p 'whisper-server-linux-x64-cuda.zip' \
  -p 'whisper-server-win32-x64-vulkan.zip' -p 'whisper-server-linux-x64-vulkan.zip'
shasum -a 256 *.zip
gh api repos/OpenWhispr/whisper.cpp/releases/tags/0.0.11 --jq '.assets[] | select(.name|test("cuda|vulkan")) | "\(.name) \(.digest)"'
```

Expected: 18 assets, which are the 14 of 0.0.10 plus the 4 `-cpu-{ivybridge,sandybridge}.zip`. The `shasum` values must equal the API's `sha256:` digests. The 0.0.11 run's `verify-cpu-levels` jobs must have passed (`gh run list --repo OpenWhispr/whisper.cpp --workflow build-binaries.yml --limit 1`). If anything other than this PR merged into master since 0.0.10, read its diff before pinning.

- [ ] **Step 2: Write the failing tests**

In `test/scripts/downloadWhisperCpp.test.js`, add this require block after the `download-utils` one:

```js
const {
  CPU_FALLBACK_LEVELS,
  WINDOWS_MSVC_RUNTIME_LIBRARIES,
  cpuFallbackServerBinaryName,
} = require("../../src/helpers/whisperCppRelease");
```

Replace the pin test:

```js
test("whisper-cpp pin is a release whose win32 zips bundle the MSVC runtime DLLs", () => {
  // 0.0.8 and 0.0.9 ship a bare exe; 0.0.10 is the first tag with the DLLs.
  assert.equal(WHISPER_CPP_TAG, "0.0.10");
});
```

with:

```js
test("whisper-cpp pin is a release with the builds for processors without AVX2", () => {
  // 0.0.10 is the first tag whose win32 zips bundle the MSVC runtime DLLs;
  // 0.0.11 is the first with the ivybridge and sandybridge builds (#2356).
  assert.equal(WHISPER_CPP_TAG, "0.0.11");
});

test("win32 and linux install the ivybridge and sandybridge builds whisperServer.js falls back to", () => {
  const keys = (platformArch) => getEntriesForPlatformArch(platformArch).map(([key]) => key);
  assert.deepEqual(keys("win32-x64"), [
    "win32-x64",
    "win32-x64-ivybridge",
    "win32-x64-sandybridge",
  ]);
  assert.deepEqual(keys("linux-x64"), [
    "linux-x64",
    "linux-x64-ivybridge",
    "linux-x64-sandybridge",
  ]);
  // No such builds for macOS yet
  assert.deepEqual(keys("darwin-x64"), ["darwin-x64"]);

  assert.deepEqual(BINARIES["win32-x64-ivybridge"], {
    platformArch: "win32-x64",
    zipName: "whisper-server-win32-x64-cpu-ivybridge.zip",
    binaryName: "whisper-server-win32-x64-cpu-ivybridge.exe",
    outputName: "whisper-server-win32-x64-ivybridge.exe",
    libPattern: "*.dll",
    requiredLibraries: WINDOWS_MSVC_RUNTIME_LIBRARIES,
  });
  assert.deepEqual(BINARIES["linux-x64-sandybridge"], {
    platformArch: "linux-x64",
    zipName: "whisper-server-linux-x64-cpu-sandybridge.zip",
    binaryName: "whisper-server-linux-x64-cpu-sandybridge",
    outputName: "whisper-server-linux-x64-sandybridge",
  });
  // The name whisperServer.js looks for is the name the download writes
  for (const level of CPU_FALLBACK_LEVELS) {
    assert.equal(
      BINARIES[`win32-x64-${level}`].outputName,
      cpuFallbackServerBinaryName("win32", "x64", level)
    );
    assert.equal(
      BINARIES[`linux-x64-${level}`].outputName,
      cpuFallbackServerBinaryName("linux", "x64", level)
    );
  }
});

test("a cached ivybridge install needs its own marker and every MSVC runtime DLL", () => {
  const config = BINARIES["win32-x64-ivybridge"];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-install-test-"));
  const binaryPath = path.join(tempDir, config.outputName);
  const markerPath = path.join(tempDir, ".whisper-cpp-win32-x64-ivybridge.json");
  fs.writeFileSync(binaryPath, "binary");
  for (const library of config.requiredLibraries) {
    fs.writeFileSync(path.join(tempDir, library), library);
  }

  try {
    assert.equal(isCompleteInstall(markerPath, binaryPath, config), false);
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ version: WHISPER_CPP_TAG, libraries: config.requiredLibraries })
    );
    assert.equal(isCompleteInstall(markerPath, binaryPath, config), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
```

In `test/helpers/gpuBinaryManager.test.js` line 166, change `/OpenWhispr\/whisper\.cpp\/releases\/tags\/0\.0\.10$/` to `/OpenWhispr\/whisper\.cpp\/releases\/tags\/0\.0\.11$/`.

Run: `node --import tsx --test test/scripts/downloadWhisperCpp.test.js test/helpers/gpuBinaryManager.test.js`
Expected: FAIL. The pin test gets `'0.0.10'`, the entries test gets `undefined` for `BINARIES["win32-x64-ivybridge"]`, and the gpuBinaryManager URL test fails on the tag.

- [ ] **Step 3: Implement**

`src/helpers/whisperCppRelease.js` line 1:

```js
const WHISPER_CPP_TAG = process.env.WHISPER_CPP_VERSION || "0.0.11";
```

In `scripts/download-whisper-cpp.js`, replace the require of `whisperCppRelease` with:

```js
const {
  CPU_FALLBACK_LEVELS,
  WHISPER_CPP_TAG,
  WINDOWS_MSVC_RUNTIME_LIBRARIES,
  cpuFallbackServerBinaryName,
} = require("../src/helpers/whisperCppRelease");
```

and change the comment line `// 0.0.10 is the first release whose win32 zips bundle the MSVC runtime DLLs (CUS-113).` to:

```js
// 0.0.10 is the first release whose win32 zips bundle the MSVC runtime DLLs (CUS-113);
// 0.0.11 adds the builds for processors without AVX2 (#2356).
```

Directly after the closing `};` of `BINARIES`, add:

```js
// The builds for processors without AVX2 that whisperServer.js falls back to when
// the primary dies of an illegal instruction (#2356), one per CPU_FALLBACK_LEVELS
// entry. Required like the primary.
for (const level of CPU_FALLBACK_LEVELS) {
  BINARIES[`win32-x64-${level}`] = {
    platformArch: "win32-x64",
    zipName: `whisper-server-win32-x64-cpu-${level}.zip`,
    binaryName: `whisper-server-win32-x64-cpu-${level}.exe`,
    outputName: cpuFallbackServerBinaryName("win32", "x64", level),
    libPattern: "*.dll",
    requiredLibraries: WINDOWS_MSVC_RUNTIME_LIBRARIES,
  };
  BINARIES[`linux-x64-${level}`] = {
    platformArch: "linux-x64",
    zipName: `whisper-server-linux-x64-cpu-${level}.zip`,
    binaryName: `whisper-server-linux-x64-cpu-${level}`,
    outputName: cpuFallbackServerBinaryName("linux", "x64", level),
  };
}
```

At the top of `EXPECTED_DIGESTS` in `src/helpers/whisperCudaManager.js`, add an entry built from Step 1's output (copy each value from `shasum`):

```js
  // Adds the whisper-server builds for processors without AVX2 (#2356); the CUDA
  // packs are rebuilt from 0.0.10's source
  "0.0.11": {
    "whisper-server-win32-x64-cuda.zip": "<shasum -a 256 of whisper-server-win32-x64-cuda.zip>",
    "whisper-server-linux-x64-cuda.zip": "<shasum -a 256 of whisper-server-linux-x64-cuda.zip>",
  },
```

and the same in `src/helpers/whisperVulkanManager.js`, with the two `-vulkan.zip` names and the comment ending "the Vulkan packs are rebuilt from 0.0.10's source". These are the only values in the plan that come from the release. Paste the 64-hex strings, never the angle-bracket text. The GPU tests pass with any 64-character value, so the Step 1 cross-check with the API digest is the real guard.

In `src/utils/gpuDetection.js`, change `// The shipped CUDA whisper build (release 0.0.10) carries kernels for Pascal` to `// The shipped CUDA whisper builds (release 0.0.10 and later) carry kernels for Pascal`.

- [ ] **Step 3b: Document the shipped fallback (moved here by A4)**

In `CLAUDE.md`, end the `whisperServer.js` fallback bullet with: `download-whisper-cpp.js installs the level builds for win32-x64 and linux-x64 only; afterPack fails packaging if one is missing`.

In `TROUBLESHOOTING.md`, after `5. Try cloud transcription as fallback`, add one list line (one line, so it merges cleanly with #2317's GPU paragraph two lines below):

```markdown
6. On Windows and Linux, processors with AVX but without AVX2 (for example 2nd- and 3rd-generation Intel Core, AMD FX, and Piledriver- or Steamroller-based AMD A-series and Athlon X4) stop the standard engine at startup (Windows exit code 3221225501, Linux SIGILL), and OpenWhispr switches to a build for older processors by itself: transcription works, more slowly. If the error says whisper-server can't run on this processor, the processor also lacks AVX (for example first-generation Core i and many Celeron, Pentium and Atom models): use a cloud transcription provider. On a Mac the same error means the Intel build cannot run there; on Apple silicon, install the Apple silicon (arm64) build.
```

- [ ] **Step 4: Run the tests and real downloads of both platforms**

```bash
npx prettier --write scripts/download-whisper-cpp.js test/scripts/downloadWhisperCpp.test.js src/helpers/whisperCppRelease.js src/helpers/whisperCudaManager.js src/helpers/whisperVulkanManager.js src/utils/gpuDetection.js test/helpers/gpuBinaryManager.test.js
node --import tsx --test test/scripts/downloadWhisperCpp.test.js test/helpers/gpuBinaryManager.test.js test/helpers/whisperServerCpuFallback.test.js
node scripts/download-whisper-cpp.js --current --platform win32 --arch x64 --force
node scripts/download-whisper-cpp.js --current --platform linux --arch x64 --force
ls -a resources/bin | grep -E "whisper-(server|cpp)"; cat resources/bin/.whisper-cpp-win32-x64-ivybridge.json
```

Expected: the tests show 0 failures. `resources/bin` holds `whisper-server-win32-x64.exe`, `whisper-server-win32-x64-ivybridge.exe`, `whisper-server-win32-x64-sandybridge.exe`, the same three for linux, and a marker per entry. The ivybridge marker is `{"version":"0.0.11","libraries":["msvcp140.dll","vcomp140.dll","vcruntime140.dll","vcruntime140_1.dll"]}` (in the archive's order). Optionally re-run the fork's instruction count on these files (`llvm-objdump -d -M intel` + a scan for AVX2/FMA/BMI2 mnemonics) for a static cross-check: expect none in the Linux builds; any on Windows should sit in MSVC STL or miniaudio dispatch code, not in ggml functions. Clean `resources/bin` afterwards.

- [ ] **Step 5: Commit, push, mark ready**

```bash
npm run lint && npm test
git add -A src/helpers/whisperCppRelease.js scripts/download-whisper-cpp.js src/helpers/whisperCudaManager.js src/helpers/whisperVulkanManager.js src/utils/gpuDetection.js test/scripts/downloadWhisperCpp.test.js test/helpers/gpuBinaryManager.test.js
git commit -m "build(whisper): pin whisper.cpp 0.0.11 with the builds for processors without AVX2"
git push
gh pr checks --repo OpenWhispr/openwhispr --watch
gh pr ready --repo OpenWhispr/openwhispr
```

Expected: build-linux, build-windows and build-macos download 0.0.11 (`[server] win32-x64-ivybridge: Extracted to whisper-server-win32-x64-ivybridge.exe`, and so on) and pass.

---

## Sequencing

| When | Repo | What | Pushed |
|---|---|---|---|
| Now | fork | F1, F2, F3 on `build/whisper-server-cpu-levels` | yes, as a draft PR; its CI run is the evidence |
| Now, in parallel | desktop | D1, D2, D3 on `fix/2356-no-avx2-cpu-fallback` | yes, as a draft PR. CI stays green because nothing yet asks for an asset 0.0.10 lacks |
| After review | fork | merge, then dispatch 0.0.11 (Part R) | human only |
| After 0.0.11 exists | desktop | D4 | yes; then mark the PR ready |
| After the app release | both | close #2356, #1418, #1613, #793 | human only |

Until D4, the desktop branch is safe to run: with no fallback build installed, a crash on an older processor ends with the new clear error rather than an empty one.

## Part R — release steps (human only)

1. Review and merge the fork PR into OpenWhispr/whisper.cpp `master`.
2. `git log 0.0.10..origin/master` must show only this PR, or you have decided to ship whatever else is there (for example the open fork PR #7).
3. Run **Actions → Build Binaries for OpenWhispr → Run workflow** on `master` with `version_tag` `0.0.11`. This publishes the release, and `verify-cpu-levels` must pass before `create-release` runs.
4. Tell the desktop executor to run D4. After the desktop PR merges and an app release ships, close #2356, #1418, #1613 and #793 with a note naming the version.

## PRs

**Fork PR** — `build: whisper-server for processors without AVX2 (ivybridge, sandybridge)`, base `OpenWhispr/whisper.cpp:master`, draft:
- Problem: every x64 CPU build needs AVX2, FMA, F16C and BMI2 (`GGML_NATIVE=OFF`), and dies at startup with STATUS_ILLEGAL_INSTRUCTION or SIGILL on Intel before Haswell and on AMD FX. Refs OpenWhispr/openwhispr#2356.
- Change: two more static CPU-only whisper-server builds per win32/linux x64, at ggml's ivybridge and sandybridge levels. On MSVC, F16C comes from `/D__F16C__`. Four new release assets. Existing assets, flags and names are unchanged.
- Why two levels: the F16C measurement from "Diagnosis check".
- Proof: the run link, the configure lines, and the 6 PASS lines per platform. The rejection lines name the violating instruction.
- CI: a PR trigger for build changes, `contents: read` by default with write only for create-release, GPU and macOS builds skipped on PRs, and release gated on `verify-cpu-levels`.
- Not changed: primary, GPU and macOS builds. The next release rebuilds them from the same source.

**Desktop PR** — `fix(whisper): fall back to whisper-server builds for processors without AVX2`, base `OpenWhispr/openwhispr:main`, draft until D4:
- Problem in plain words, and the new behaviour.
- Depends on OpenWhispr/whisper.cpp 0.0.11 (link the fork PR). Until D4 lands, the fallback finds no build and reports the clear error.
- Tests: the 11 in `whisperServerCpuFallback.test.js`, plus the download tests. What they simulate (the SIGILL fakes), and what is not verified (below).
- Conflicts: PR #2317 makes the same close-handler and `startupTimeoutMs` changes under the same names. A `git merge-file` against #2317's diff leaves one conflict: #2317's extra line `this._lastProcessInfo = getProcessInfo;`. Resolve it by keeping that line. The fallback branch merges cleanly with #2317's rewrite of the GPU branch.
- `Refs #2356. Also reported in #1418, #1613 and #793.` Close them by hand after the release.

## Validation, evidence, acceptance

| Check | Command | Evidence |
|---|---|---|
| Compile flags per build | fork "Check each build's CPU level" steps | exact CMake lines (toolchain), plus the MSVC cache define |
| Runs on the target processor | `verify-cpu-levels` checks 1–2 | emulated (SDE and QEMU): a real model, VAD, a correct transcript, the binary's own feature report |
| The emulator enforces the level, and the build dies at startup | checks 3–4 | emulated; this is the desktop's assumption |
| Shipped layout with llama.cpp's libraries | check 5 | emulated, startup only |
| Fallback logic, stickiness, GPU interplay, races, the error text | `node --import tsx --test test/helpers/whisperServerCpuFallback.test.js` | real spawns of fake builds (Linux CI and macOS); the Windows code only through `isIllegalInstructionExit` |
| Download: required entries, markers, cleanup | `test/scripts/downloadWhisperCpp.test.js`, D4 Step 4 downloads | unit tests plus real 0.0.11 assets |
| No regressions | `npm run lint`, `npm test`, `npm run typecheck`; desktop CI | CI's clean install |

Acceptance, as a user sees it:
1. On an Ivy Bridge, Piledriver or Jaguar PC (Windows or Linux), local Whisper transcribes with no failure toast. The debug log shows one "retrying with a build for older processors" warning per launch.
2. On a Sandy Bridge or Bulldozer PC, it transcribes, more slowly. The log shows two such warnings per launch.
3. On AVX2 machines nothing changes: the same primary build, no extra launches, no new log lines.
4. On a processor without AVX, the toast reads "Local Whisper failed: … whisper-server can't run on this processor: whisper-server-…-sandybridge… stopped on an instruction the processor doesn't support (…), and no build for older processors is left to try". The app does not relaunch in a loop, and other providers keep working.
5. With a CUDA or Vulkan pack on such a PC, dictation completes on CPU, and the GPU card shows the fallback as it does today.
6. macOS gets no level builds. A darwin-x64 build that dies of an illegal instruction (a patched pre-Haswell Mac, or Apple silicon running the Intel build under Rosetta before macOS 15) now fails with "can't run on this processor" and skips the thread retry, instead of the bare startup error.

## What this plan cannot verify here

- Real Sandy Bridge, Ivy Bridge, AMD FX or Jaguar hardware. Every run-time proof is emulated.
- Transcription speed on those processors. There are only relative numbers, from Rosetta on a loaded host.
- A packaged Windows install: NSIS, Windows Error Reporting's handling of the first crash on each launch, and the real `resources/bin` library scan outside SDE.
- A packaged Linux install (AppImage, deb, rpm) on real hardware.
- How MSVC configures the ivybridge tree, how SDE behaves on GitHub runners, and QEMU 8.2's IvyBridge model. All three are first seen in the fork PR run.
- macOS on Intel Macs without AVX2 (possible only on patched macOS). They get the clear error, because there is no Mac build for older processors.

## Follow-ups (out of scope)

- GPU packs (CUDA, Vulkan) are built with the same AVX2 flags, so on these processors they fall back to CPU. They would need their own level builds.
- A processor without AVX (SSE4.2 only: first-generation Core i, and many Celeron, Pentium and Atom chips): a `sse42` level would be one more entry in `CPU_FALLBACK_LEVELS` and the workflow.
- Intel Macs without AVX2 on patched macOS, and Apple silicon Macs running the Intel build under Rosetta before macOS 15 (no AVX there): a darwin-x64 level build, or a hint to install the arm64 build.
- Skip `ggml_backend_load_all()` in the fork's static whisper-server (guard it with `GGML_BACKEND_DL`). It would stop loading llama.cpp's libraries for every user. That would remove the layout risk check 5 watches, but it is a source change.
- Remember the working build across launches, as `.env` plus an upgrade reset like `whisperGpuUpgradeReset.js`, if the one startup crash per launch proves noisy (Windows Error Reporting, core dumps).
- #963's localized "processor not supported" toast. It can key on the new message.
- Long term, GGML_BACKEND_DL with GGML_CPU_ALL_VARIANTS (runtime dispatch) in its own folder, replacing the fixed builds.
- Upgrade `softprops/action-gh-release@v1` (actionlint: its runtime is too old).
