# Hold and Hands-free — design

Date: 2026-09-07 · Base: PR #1978 (`feature/hotkey-activation-modes`, head `7a3cd9b7`) · Author: Claude with Josh
Design page (ground-truth filmstrips, one-to-one prototypes, decisions): https://claude.ai/code/artifact/312f3f40-4264-4bc4-92c5-5e62bae20df4 (v2.2)

## 1. What we are building

One activation model for every hotkey: **hold to speak, release to finish**. A **double press of the same key** latches a hands-free recording; the next press stops it. Tap-to-toggle stops being a user choice. The change is introduced by a one-time card, explained by two read-only gesture rows under each hotkey in Settings, and accompanied by a retimed set of pill and panel transitions built from the app's own DOM and CSS.

Decisions approved by Josh on 2026-09-07 (design page, "Decisions" 1–7). Decision 8 (agent mark held through an auto-hide exit) was approved the same day, later.

### Goals
- Everyone on Hold; nobody has to pick a mode.
- Hands-free is discoverable from the hotkey section and from the existing hands-free tip (PR #1992), never from onboarding.
- The pill and panel motion is smooth at the frame level, with no state or animation removed.

### Non-goals
- Onboarding changes. A separate cross-check runs after the build (Titan task `hotkey-hold-onboarding-cross-check`).
- Linux Hold parity beyond what #1978 already does (Titan task `linux-hold-parity-deep-dive`).
- Shaders or any GPU-side effect. CSS transforms, opacity and clip-path only.

## 2. Gesture model (ships in #1978)

**Already in the PR, unchanged:** the double-press latch (`src/helpers/pressGesture.js`: second press 150–400 ms after the first → `latch`; a press during a latched recording → `stop-hands-free`), the push-to-talk machines in `windowManager.js`, the per-slot Hold capability check (`hotkeyManager.supportsPushToTalk`), and the fallback that demotes a slot to tap-toggle when its hotkey or backend cannot Hold (`demoteHold`).

**Changes:**

1. **Default is `push`.** Renderer (`settingsStore.ts`: `activationMode`, `voiceAgentActivationMode`, `translationActivationMode`) and main (`environment.js`: `ACTIVATION_MODE` and the slot keys) both default to `push` instead of `tap`.
2. **One-time migration, both sides.** On first start after the update, a stored `tap` becomes `push` for every slot whose registered hotkey can Hold. Pattern: a module-scope `migrateActivationModesToHold()` next to `migrateMicrophoneSelectionMode()` with a `activationModeHoldMigration=done` marker in localStorage; the main side runs the same rule when the hotkey manager registers each slot (it already demotes an unsupported Hold, so the main-side rule is "prefer `push`, let `demoteHold` decide"). Slots that cannot Hold stay `tap`, and Settings says why (item 4).
3. **Remove the choice.** `ActivationModeRow` and its `ActivationModeSelector` leave `SettingsPage.tsx`. The selector component stays in the tree for `OnboardingFlow.tsx` until the onboarding cross-check decides its fate (non-goal above). The `setActivationMode` IPC and store setters stay, because the migration and the demotion path use them.
4. **Two gesture rows per hotkey section** (dictation, voice agent, translation), read-only, in the keycap token style of the hands-free tip card (#1992 `HandsFreeTipCard`, class `hands-free-tip-badge` and its `kbd` tokens):
   - **Hold to speak** — Release to finish · `Hold` + the slot's keycaps
   - **Hands-free** — Press again to stop · `Double press` + the same keycaps
   When the slot cannot Hold, one row instead: **Press to start, press again to stop**, followed by the existing reason line (`pushToTalkUnavailableReason`). Meeting mode keeps its current layout. Copy lives in `translation.json` under `settingsPage.general.hotkey.gestures.*`; the ten other locales get the English strings until translated.
5. **Migration card**, shown once in the pill window on the first hotkey press after a migration actually changed a slot (fresh installs never see it). Chrome: the hands-free tip card's shell. Content, final: chip "New in this update"; title "Hold to speak, release to finish"; body "We changed how your hotkey works: hold ⌃ ` while you talk." (keycaps rendered as tokens for the user's real dictation hotkey) and "Double press it for hands‑free, press again to stop." No button. Dismissed by the X or by the next press. Flag `holdMigrationCardShown` in the renderer store; window size via the ladder entry #1992 adds for the tip card.

**Relation to #1992.** `feature/hands-free-tip` (#1992) is based on `feature/hotkey-activation-modes`, so it already contains every commit of #1978 plus three of its own (the tip card, hold-duration logging, and the macOS bare-Globe/right-modifier release fix). The gesture rows and the migration card reuse its `HandsFreeTipCard` shell and keycap tokens, so the work is built on that stack: either #1992 is merged into `feature/hotkey-activation-modes` so #1978 becomes the single PR, or the new commits go on top of `feature/hands-free-tip` and #1992 absorbs them. Nothing is lifted or duplicated either way.

## 3. Motion (its own PR, stacked on #1978, one commit per transition)

Principles, from the performance read on the design page: animate only `transform`, `opacity` and `clip-path`; the native window never resizes during a visible transition (grow before, shrink on `transitionend`); chain on `transitionend` with a timeout fallback, never on bare timers; springs as CSS `linear()` easings generated once in JS (`morph` k 300 c 26 ≈440 ms; `show` k 380 c 28 ≈260 ms; `zoop` k 520 c 46 200 ms); `prefers-reduced-motion` collapses everything to 1 ms as today. Every colour, size, radius and shadow stays. Nothing is removed.

| Transition | Today (measured) | Proposed |
|---|---|---|
| Listening entrance | 420 ms hold, then width/height/padding transition 300 ms, waveform +100 ms | same hold; widen by clip-path on a fixed 92×40 box with the morph spring; waveform slides in on the right by transform |
| Stop → idle | narrow 300 ms, window shrink on a 340 ms timer | same narrow; window shrink on `transitionend` |
| Panel open | window pre-grows, shell clip-path opens 280 ms from the corner point | pre-grow unchanged; shell springs from the pill's circle; pill glides to the footer during it |
| Streaming reply | text appends in blocks, caret blinks | per-word rise 320 ms with 28 ms stagger; caret unchanged; settled blocks never re-rendered |
| Copy tick | tick for 6 s, 150 ms colour switch back | tick pops (existing `tool-check-pop`), 6 s hold, label crossfades 320 ms back |
| Panel close | fade 100 → empty frames → shell 280 → pill alone purple (300 ms stall seen) → leaf→ring 480 → window snap + 16 px jump; ≈1.15 s | actions retreat + fade 120 ms; one morph spring from shell to the pill's circle at the resting dock with the colour fading inside it; window shrinks on `transitionend`; ≈560 ms |
| Companion pill on close | hidden with a hard cut at close intent | fades 160 ms on the same clock |
| Hide | `hide()` hard cut | "zoop": 200 ms scale to 0.04 toward the pill's centre with a 2 px squash, opacity out over the last 40 %; window hides after |
| Show | `showInactive()` hard cut | window shows transparent, pill unzoops 260 ms with 4 % overshoot |
| Live transcript tail | stepped `background-clip` shimmer | opacity-only tail (62 % → 100 % on commit); entrance stages and durations unchanged, timer chain becomes event-driven |

### Decision 8 (approved): agent mark held through an auto-hide exit

**Today.** When the panel unmounts, three clocks start together: the window snaps to its base size (`useMainWindowSizeOwner`, returning-from-panel path), the mark morphs from leaf to ring over 480 ms (`VOICE_IDENTITY_MORPH_DURATION_MS`), and the auto-hide timer in `App.jsx` fires `hideWindow()` at 500 ms. The ring finishes forming 20 ms before the cut, so a user who just talked to the agent watches the pill turn into the dictation logo and then vanish.

**Proposed.** Hold the agent identity while the window is on its way out. `resolveAgentModeActive` (`voicePillPresentation.js`) gains one input, `heldThroughHide`; `App.jsx` sets it at close intent when `floatingIconAutoHide` is on and the panel was the agent's, and clears it after the `hideWindow` IPC resolves, on any new recording start, or when auto-hide is switched off while the pill is still visible. The close spring lands the pill wearing the leaf, the zoop takes the leaf with it, and the leaf→ring morph runs while the window is hidden, so the next show is the dictation pill. Stopping a dictation with auto-hide on is unchanged: the pill leaves wearing the ring. Renderer only; no main-process change.

## 4. Verification

- **Unit:** `test/helpers/voicePillPresentation.test.js` covers `resolveAgentModeActive` with the new input (held → true after unmount; cleared → false; recording start wins). A migration test for `migrateActivationModesToHold` (tap→push, marker set, unsupported slot stays tap, second run is a no-op). `pressGesture.test.js` and `windowSizeLadder.test.js` unchanged.
- **Frame-level:** each motion commit is captured with the `ow-ui-capture` skill on the dev-build rig and graded against the filmstrip on the design page. Pass: the anatomy matches the proposed row, the in-page frame probe reports no frame over 34 ms during the transition on the M-series rig, and the window never changes size while a transition is visible.
- **Testbook:** `openwhispr-pr-testbook` for #1978 extended with the migration (upgrade from a `tap` profile, from a `push` profile, fresh install), the gesture rows on macOS and on a Linux backend that cannot Hold, and the card's two dismissals.

## 5. Resolved questions

1. Decision 8: approved 2026-09-07.
2. PR ordering: #1992 already sits on top of #1978 (section 2, "Relation to #1992"); the build starts from that stack. Which of the two branches carries the new commits is a mechanics choice made in the implementation plan.
