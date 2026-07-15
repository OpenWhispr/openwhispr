# Plan: Local-only onboarding, best-local-model default, bundled FluidAudio, shareable unsigned builds

**Date:** 2026-07-15 · **Repo:** `openwhispr` fork (futuregerald) · **Strategy:** unwire, don't delete — keep upstream merges clean. Auth/cloud code stays intact and opt-in via Settings.

## Decision baked in (Gerald can veto)

Default transcription = **local whisper, model `turbo` (large-v3-turbo, 1.6GB)**. Rationale: best accuracy that's still fast on Apple Silicon, the fork's target hardware. Coworkers on weaker machines can switch to `small`/`base` in the onboarding setup step or Settings. Reversal is a one-line change per default (Task 2, lines 872–873 of `settingsStore.ts`).

---

## Task 1 — Remove the signup gate from onboarding

**File:** `src/components/OnboardingFlow.tsx`

1. **Line 138:** `const [skipAuth, setSkipAuth] = useState(false);` → `useState(true);`
   The full "continue without account" path already exists (`onContinueWithoutAccount` 537–540, `authenticationSkipped`/`skipAuth` localStorage persistence 370–373, read by `AppRouter.jsx:75–77`). Defaulting `skipAuth = true` activates it globally: every `isSignedIn && !skipAuth` gate (voiceAgent step ~219, cloudPost intent sync 427, merged setup/permissions branch 561) resolves to the local path with zero further edits.
2. **Line 209:** delete the `welcome` steps-array entry: `{ id: "welcome", title: t("onboarding.steps.welcome"), icon: UserCircle },`
   Onboarding now starts at `usecase`. **Do not** delete the `case "welcome":` block (525–548), `AuthenticationStep`/`EmailVerificationStep` imports (lines 33–34), or the components themselves — dead-but-wired code merges cleanly with upstream. If the linter flags unused `UserCircle`, prefix the steps-array line with a comment rather than removing the import, or suppress.

**No changes to `AppRouter.jsx`:** `saveSettings` (370–373) persists `authenticationSkipped=true`/`skipAuth=true` because `skipAuth` state is now true, so the not-signed-in reauth redirect (`AppRouter.jsx:89–90`) never triggers. `saveSettings`' BYOK flip (383–385) also becomes a no-op once local is the default (Task 2) — harmless either way. Signing in later from Settings re-enables cloud features untouched.

**Verify:** clear localStorage (DevTools → Application → Clear site data, or fresh `userData`), `npm run dev`, walk the wizard: first screen is Use Case (no signup), permissions step present, no voiceAgent step, finish completes; confirm `localStorage.authenticationSkipped === "true"` and no requests to `auth.openwhispr.com` (Network tab). Then open Settings → account section still reachable for optional sign-in.

## Task 2 — Default to local transcription with `turbo`

**File:** `src/stores/settingsStore.ts`

- **Line 872:** `useLocalWhisper: readBoolean("useLocalWhisper", false)` → default `true`.
- **Line 873:** `whisperModel: readString("whisperModel", "base")` → default `"turbo"`.

Leave `fallbackWhisperModel: "base"` (line 878) and cloud defaults (882–890) alone — cloud stays opt-in.

**File:** `src/models/modelRegistryData.json` — move `"recommended": true` from the `base` entry (line 131) into the `turbo` entry (lines 164–173, after `"downloadUrl"`). JSON shape confirmed: flat per-model objects with an optional `recommended` boolean.

**Migration note:** `readBoolean`/`readString` read persisted localStorage first — these defaults apply to **fresh installs only** (i.e., every coworker share). Existing installs keep their choice; no migration shipped, intentionally.

**Verify:** fresh localStorage + `npm run dev` → onboarding `setup` step (inline TranscriptionModelPicker + LanguageSelector, lines 560–671) shows Local mode with **Turbo** pre-selected and a single "Download & continue" action. If the picker's initial mode comes from its own local state rather than the store, fix the picker's initializer to read the store default — check this during implementation. Complete a dictation with turbo end-to-end.

## Task 3 — Bundle FluidAudio into production builds

**File:** `electron-builder.json` — in the `extraResources` filter whitelist (lines 102–132), add `"fluidaudio-diarize-*",` alongside `"meeting-aec-helper-*"`. Without this the binary (`resources/bin/fluidaudio-diarize-darwin-arm64`, confirmed present) is silently dropped. `diarization-models/**` and `whisper-vad/**` are already whitelisted.

**File:** `package.json` — append `&& npm run setup:fluidaudio` to **`prebuild:mac`** (line 36) and **`prebuild`** (line 31). `setup:fluidaudio` (line 72) already no-ops off macOS, so `prebuild` stays cross-platform safe. npm's `pre` lifecycle runs these automatically before `build:mac`/`build`.

**Verify:** `npm run build:mac:arm64`, then `ls "dist/mac-arm64/OpenWhispr.app/Contents/Resources/bin/" | grep fluidaudio` shows the binary. Install the dmg on a machine (or fresh account) that never ran `setup:fluidaudio`, record with 2 speakers, confirm FluidAudio engine is used (app log / engine indicator per `docs/FLUIDAUDIO-INTEGRATION.md`) — this also proves the runtime resolver checks `process.resourcesPath/bin`.

## Task 4 — Build without upstream's Apple Developer identity

**File:** `electron-builder.json`, mac block (143–166):

- **Line 151:** `"identity": "Gizmo Labs Inc. (T832773L2J)"` → `"identity": null` (electron-builder skips real signing; ad-hoc signs on arm64, which macOS requires).
- **Line 152:** `"notarize": true` → `"notarize": false`.
- Keep `hardenedRuntime`/`gatekeeperAssess` as-is. If Gerald later gets a Developer ID, revert both lines and export `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` — note this in FORK-SETUP.
- **Lines 264–270 (publish block):** `"owner": "OpenWhispr"` → `"futuregerald"`. Add a doc note: electron-updater cannot auto-update unsigned mac apps — coworkers reinstall dmgs manually.
- **Line 97:** `.env` is bundled via `extraResources` — before building a shareable dmg, verify `.env` contains no personal API keys (or build from a sanitized copy).

**Verify:** `npm run build:mac:arm64` completes with no `CSC`/notarization errors on a machine without upstream certs; `codesign -dv dist/mac-arm64/OpenWhispr.app` shows ad-hoc signature; installed app launches after `xattr -dr com.apple.quarantine /Applications/OpenWhispr.app`.

## Task 5 — Docs

1. **`README.md`** — after "Quick start" (line 59), add a **"Production build (macOS)"** section: `npm run build:mac:arm64` (prebuild auto-runs native compile, model downloads, and FluidAudio setup); output dmg+zip in `dist/`; builds are unsigned/un-notarized → recipients run `xattr -dr com.apple.quarantine "/Applications/OpenWhispr.app"` once after installing. Note first launch downloads the `turbo` whisper model (~1.6GB); weaker machines can pick `small`/`base`.
2. **`docs/FORK-SETUP.md`** — "Sharing with coworkers" Option B (lines 46–59): drop the manual `npm run setup:fluidaudio` line (now automatic in `prebuild:mac`); state that signing/notarization are disabled in `electron-builder.json` (`identity: null`, `notarize: false`) and how to re-enable with a real Developer ID; keep the `xattr` step; update "What's in this fork vs upstream" table with local-only onboarding + turbo default + bundled FluidAudio.

## Ordering & dependencies

Tasks 1–2 are independent of 3–4. Do **2 before 1's verification** (the setup-step check assumes the new defaults). Task 3 depends on 4 to actually produce a build without cert errors — implement 4 first or together. Task 5 last. Suggested order: **4 → 3 → 2 → 1 → 5**, single branch, one conventional commit per task.

## Risks & rollback

- **Existing installs** keep persisted localStorage settings — defaults don't retro-apply (accepted; fresh shares are the goal). Rollback of any default = revert the one-liner.
- **Cloud still works when opted in:** nothing auth-related is deleted; sign-in from Settings restores cloud/voiceAgent behavior. Regression check: sign in post-onboarding and run one cloud transcription.
- **Upstream merges:** all edits are default-value flips, one deleted array entry, and additive build config — low conflict surface. `AuthenticationStep` render path retained intentionally.
- **`turbo` on Intel/low-RAM Macs** may be slow — mitigated by picker choice; if it bites, flip line 873 back to `"small"`.
- **Unsigned builds:** Gatekeeper friction (`xattr`) and no mac auto-update; documented, reversible with a Developer ID.
