# iOS keyboard quality: iteration ledger

Branch `feat/mobile-keyboard-quality`, worktree `worktrees/keyboard-quality`. Started 2026-11-20.

**Next action:** Build the lexicon and language model (`tools/build-lexicon.py`, UIKit-free Swift reader) once the Leipzig downloads finish, then the benchmark harness in plain swiftc.

## Criteria

| #   | Criterion                          | Status     | Current numbers                                                                                                                                                                                                                                                           | Blocked reason |
| --- | ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Typing parity with iOS             | partial    | Has shift, caps lock (0.33 s double tap), auto-capitalization, double-space period, 123 and #+= pages, light/dark, SE to Pro Max in both orientations. Missing: long-press accents, number pad, field rules for autocorrect, UILexicon, contractions, Clear learned words |                |
| 1a  | Space-bar trackpad                 | missing    |                                                                                                                                                                                                                                                                           |                |
| 1b  | Dynamic hit targets                | missing    | Today: fixed nearest-key routing in `KeyboardRowsStack.hitTest`                                                                                                                                                                                                           |                |
| 1c  | Top bar with suggestion bar        | missing    | Strip is 40 pt + gap; no suggestions                                                                                                                                                                                                                                      |                |
| 1d  | Emoji panel                        | missing    |                                                                                                                                                                                                                                                                           |                |
| 2   | Haptics                            | missing    | Input clicks only (`playInputClick`)                                                                                                                                                                                                                                      |                |
| 3   | Layouts and languages (en/de)      | missing    | QWERTY only, no typing-language setting                                                                                                                                                                                                                                   |                |
| 4   | Autocorrect                        | missing    |                                                                                                                                                                                                                                                                           |                |
| 5   | Swipe typing                       | missing    |                                                                                                                                                                                                                                                                           |                |
| 6   | Performance (latency, memory)      | unmeasured |                                                                                                                                                                                                                                                                           |                |
| 7   | Existing checks green              | partial    | Baseline 2026-11-20 23:11: touch tests 398/398, capitalization PASS, direct PASS. Jest, typecheck, lint, format, doctor, simulator build not run yet                                                                                                                      |                |
| 8   | Visual review next to iOS keyboard | partial    | en/QWERTY keys were matched to Apple's by measurement; no screenshot harness yet                                                                                                                                                                                          |                |
| R   | Research pass + Local-dictation    | done       | Competitor pass and Local-speech spike both in the log. Spike commit `a2d126ed9` on `spike/keyboard-local-speech` (worktree `worktrees/keyboard-local-speech-spike`). Works in the extension: needs a phone test                                                          |                |

## Waiting on Chad

Nothing yet.

## Benchmark test-split hashes

Frozen 2026-11-20 in `plugins/keyboard-extension/tests/benchmarks/`. Never edit these files.

| File                       | Lines | SHA-256                                                            |
| -------------------------- | ----- | ------------------------------------------------------------------ |
| `sentences.en.test.txt`    | 1930  | `993f934fc51fe1334fc43516dd95b03fa31cda6bfc7775ea27ef3d2a968b0edd` |
| `typos.en-qwerty.test.tsv` | 5000  | `f9a7094c68cd6ede2dba6a16c5ffff9cc4eebcac67ebe4fed5d008935041b9bb` |
| `misspellings.en.test.tsv` | 2049  | `b1e47ff543e8b5fd70485a98a3d5567ce3ca518fa4dce91a800d2ed7d260a344` |
| `swipe-words.en.tsv`       | 10000 | `07fb95e32b63e9de70adfa130cb517d6365b34c07a51418d80dc3b62be6b66b6` |
| `sentences.de.test.txt`    | 967   | `a1c318863ad6c873be529a90418acba540d32802cdd7c42fdff8003b0ac6a223` |
| `typos.de-qwertz.test.tsv` | 5000  | `72fad876b56c293dbd308ab1dab856bfe8d607dfefdc90d79ffcf928b6fba6b3` |
| `misspellings.de.test.tsv` | 64    | `95d99845a1d798cb15cd5811f933f004af2225b686ea085db85d534ba90080db` |
| `swipe-words.de.tsv`       | 10000 | `0ea6ad06eeb826bef38a173f63e3a980278dfe61759285cc998104ad671bae12` |

Simulated taps (1b) and swipe paths (5) are generated by the Swift harness from fixed seeds over these files; the generator file hashes are added below when the harness is frozen.

## The prompt (verbatim copy)

Goal: make the OpenWhispr iOS keyboard (the monorepo's openwhispr-mobile app: the OpenWhisprKeyboard extension, source in openwhispr-mobile/plugins/keyboard-extension) the best keyboard on iOS: at least as good as Apple's for typing, and better than Raycast's and Superwhisper's for dictation. The acceptance criteria below alone define done. Work through them, then stop and report.

How this prompt overrides my usual rules
You are running unsupervised for up to 24 hours. For this task only: you don't need my approval for the plan or for individual steps, don't ask clarifying questions before starting, and you may delete build output inside your own worktree (ios/build, DerivedData you created) without asking. Everything else in my global rules still applies.

Setup (do this first)

1. The worktree /Users/chadpiha/Development/openWhispr/openwhispr/worktrees/keyboard-direct-dictation (branch feat/mobile-keyboard-direct-dictation) holds finished, reviewed, uncommitted work: in-place dictation, 48 files. Commit it as is, in one conventional commit on that branch. Don't change it first. Leave its git-ignored .superpowers folder alone.
2. Create branch feat/mobile-keyboard-quality from that commit, in a new worktree at /Users/chadpiha/Development/openWhispr/openwhispr/worktrees/keyboard-quality. Symlink openwhispr-mobile/node_modules to /Users/chadpiha/Development/openWhispr/openwhispr/openwhispr-mobile/node_modules (the lockfiles match). Don't copy or create any .env file. Simulator builds use the default development bundle id, com.gizmolabs.openwhispr.dev. Do all your work in this worktree.
3. Create the ledger at openwhispr-mobile/docs/keyboard-iteration-ledger.md. At its top, put a copy of this whole prompt, a "Next action" line, a criteria table (status, current numbers, blocked reason) and a "Waiting on Chad" section. Below that, keep an append-only log. After every iteration, update the table and the Next action line. Whenever you resume or your context was compacted, read the ledger before anything else. Keep the file Prettier-formatted.
4. Audit what's already there before changing anything. The current keyboard has: the top bar (tone menu left, dictation pill centre, assistant right), key popups, caps lock, accelerating delete, returnKeyType styles, email/URL/web-search bottom rows, the globe key via needsInputModeSwitchKey, and input clicks. It has no suggestion bar, trackpad, emoji, spell checking, haptics, number pad or QWERTZ. Mark each criterion pass, partial or missing in the table.

Authority and limits

- Make small conventional commits on feat/mobile-keyboard-quality. Before every commit, check that `git config user.name` is Chadpiha. The only commit outside this branch is Setup step 1. Never push, open a PR, merge, rebase or touch main or any other branch. Never run `git stash` (the stash list is shared with other worktrees). To undo your own work, use `git revert` on your own commits.
- Never edit .env files. Add no npm or Swift packages. If one turns out to be unavoidable, put it under "Waiting on Chad".
- Data: you may download word-frequency lists, misspelling and sentence corpora, Unicode emoji data (unicode.org) and CLDR annotations (github.com/unicode-org/cldr). Data under the Unicode License v3, CC-BY or CC-BY-SA, or MIT/BSD/Apache, is pre-approved for files bundled in the keyboard or checked in as test data. Credit every source in openwhispr-mobile/plugins/keyboard-extension/data/LICENSES.md. Never use GPL data. Anything else goes under "Waiting on Chad".
- The npm registry may be blocked in this sandbox (GitHub works). If a check fails only for lack of network (expo-doctor), record it and move on.
- No new entitlements. Assume the user has granted Full Access. Without it, keep today's behaviour (the "Turn on Full Access" pill), with no new requirements for that path.
- When something needs my decision, or a blocker survives two different attempts, record it under "Waiting on Chad" with what you tried, then keep working on the other criteria. Stop early only when nothing else can move forward.

Product principles

- Dictation stays the main feature: at rest, the dictation pill is the largest and most prominent action. No typing feature makes it slower to reach. The voice assistant and tone buttons keep today's show and dim rules.
- Users choose OpenWhispr Cloud or Local, and the keyboard treats both as first-class. Never send audio to the cloud for a user who chose Local, and never make one mode worse to improve the other.
- Don't change when direct dictation runs or falls back to the app. The rules (off by default for the first TestFlight build, iOS 26+, handoff when other audio plays or output is Bluetooth, handoff for Local, Bring Your Own Key, guests, custom cleanup prompts and the assistant) are in /Users/chadpiha/Development/openWhispr/openwhispr/docs/superpowers/specs/2026-11-19-ios-keyboard-in-place-dictation-design.md. Only the layout of the strip it lives in may change.
- Typing features (autocorrect, swipe, suggestions, learned words) run on the device. Keystrokes and typing history never leave the phone or reach logs, and learned words stay in the App Group container.
- It should feel native: match iOS key sizes, hit targets, popups, sounds and timing unless we're deliberately doing better.

Research (one short pass, after the audit)

- Study Apple's keyboard, Raycast's and Superwhisper's iOS keyboards, and Gboard/SwiftKey for swipe and autocorrect. Write what each does best into the ledger and add anything worth having to your plan. Don't copy their art or branding.
- Local dictation inside the keyboard: Local users still hand off to the app because Whisper and Parakeet won't fit in a keyboard's memory. Work out a design where the keyboard records with the same WebKit capture direct dictation already uses (WebAudioCapture.swift; don't use AVAudioEngine in the extension), then transcribes on the device with Apple's speech APIs (SpeechAnalyzer, iOS 26+), which run in a system process. Test accuracy and speed on the Mac with recorded audio files, in English and German. List what it would lose (cleanup, tone, dictionary) and what the extension's Info.plist would need. A throwaway spike is allowed on its own branch, spike/keyboard-local-speech, cut from feat/mobile-keyboard-quality and never merged into it. Mark whether it works in the extension as "needs a phone test". Don't build it into the product: that call is mine.

Languages and layouts
Two typing languages: English and German. Two layouts: QWERTY and QWERTZ. Add a typing-language setting (separate from the dictation language) and a layout setting, both in the app's preferences and stored in the App Group. Default the language from Locale.preferredLanguages and the layout from it (German → QWERTZ, otherwise QWERTY); the user can pick either layout for either language. Add a way to switch typing language inside the keyboard that doesn't clash with the space-bar trackpad (for example, long-press the emoji key), and record the choice. Benchmarks run on en/QWERTY and de/QWERTZ. Criteria 1, 1a, 2 and 8 must also pass for English on QWERTZ.

Acceptance criteria (all must pass, or be marked blocked with evidence)

1. Typing parity with iOS:
   - long-press accents, shift and double-tap caps lock, auto-capitalization, double-space period
   - number and symbol pages, a number pad for numberPad/decimalPad/phonePad fields
   - light and dark mode
   - every iPhone size from SE to Pro Max, in portrait and landscape
   - honour each field's settings: no autocorrect or learning when autocorrectionType or spellCheckingType is .no, in URL and email keyboards, or for textContentType username, password, oneTimeCode and email; never learn in fields that hide their text
   - iOS text replacements from UILexicon ("omw"), English contractions, and a "Clear learned words" control in the app

1a. Space-bar trackpad, as on the iOS keyboard. Press and hold the space bar: the key labels fade with a haptic tick. Dragging moves the cursor one grapheme per small step, with acceleration on fast drags. Lifting your finger ends it and leaves the cursor where it is. A tap still types a space, and a quick swipe across the space bar never starts trackpad mode. Horizontal moves use textDocumentProxy.adjustTextPosition, with a local model of the cursor during the drag, since documentContextBefore/After lag behind. Vertical moves cross hard line breaks only, keeping the column where possible. Test the hold threshold, tap vs hold vs swipe, cursor offsets for a scripted drag, and clean stops at the start and end of the text.

1b. Dynamic hit targets, as on the iOS keyboard. The keys look the same, but the touch boundary between neighbouring keys shifts toward the letter the language model expects next. Measure with simulated taps scattered around each intended key's centre (Gaussian, standard deviation a quarter of a key width), over the held-out sentence test split (see Benchmarks):

- wrong letters drop by at least 25% compared with fixed targets
- a tap in the inner 60% of a key always types that key

Update existing touch tests only where they assumed fixed geometry, and list which in the ledger.

1c. Top bar: keep tone (left), dictation (centre) and the assistant (right) with today's show and dim rules, and add a 3-slot suggestion bar. At rest, the dictation pill is the largest thing in the strip. While suggestions show, dictation stays a separate tap target of at least 44 pt. Build and screenshot two options:

- (A) one strip that shows the three buttons at rest and, while a word is being typed, puts the suggestions between tone and the assistant, with dictation as a mic button
- (B) a suggestion row above today's toolbar

Compare heights with Apple's keyboard from screenshots, leaving out the system bar below the keys. Aim for no more than 8 pt taller than Apple's with its suggestion bar. Build B even if it exceeds that, for comparison. Pick one, record the screenshots and your reasons, and leave the other easy to switch to. I may overrule the pick.

1d. Emoji: third-party keyboards can't open Apple's emoji keyboard, so build our own panel.

- Bottom row: `123 | emoji | space | return`, with the globe key added when needsInputModeSwitchKey is true.
- Every emoji the running iOS version can draw (filter out ones it can't, since the extension supports iOS 15.1), in Apple's categories with a tab bar, plus Recents.
- Search by name in the typing language (English and German CLDR names), with typed keys going into the search field rather than the document.
- Skin tones on long-press, with the last choice remembered per emoji.
- Recents and skin tones are stored in the App Group.
- The suggestion bar offers an emoji for words that have one ("pizza" → 🍕).
- Load emoji data lazily and draw glyphs as text, never images.

2. Haptics: a light tap on every key, on by default, with a setting to turn it off. Key clicks follow the system setting. Test by injecting the feedback generator and counting calls, since the simulator can't feel them.
3. Layouts and languages as described above, with every benchmark passing for en/QWERTY and de/QWERTZ.
4. Autocorrect: the suggestion bar from 1c, and on-device correction from UITextChecker, UILexicon, bundled frequency lists and learned words. Backspace right after a correction undoes it, and common real-word slips ("form" → "from") are handled where the context makes them clear. On the test split, per language:
   - real misspellings: ≥ 80% corrected to the right word (top-1)
   - synthetic near-miss typos for the language's layout: ≥ 90% top-1
   - over-correction on at least 10,000 tokens of held-out natural text, including names, URLs and slang: ≤ 1% of correct words changed

   Run the autocorrect benchmark in the iOS simulator, or with a frozen candidate generator, and say which in the ledger, since the Mac's spell checker gives different results.

5. Swipe typing, on the 10,000 most common words per language and layout:
   - Simulated paths: Gaussian noise (standard deviation 0.2 key width) at each key centre, corner cutting, 60–120 Hz sampling, ±30% speed.
   - Top-1 ≥ 90% and top-3 ≥ 97%, frequency-weighted (report uniform figures too).
   - Decode ≤ 25 ms on the Mac.
   - A swipe never types stray letters. Fast taps with small slides (up to 0.3 key) and overlapping taps never decode as a swipe, and swiping doesn't trigger long-press accents.
6. Performance:
   - Latency from touchesEnded to the insertText call returning, in a Release build on the simulator: ≤ 8 ms, as headroom for the phone.
   - Peak phys_footprint during a scripted session (typing, swiping, scrolling the whole emoji panel, starting a dictation): ≤ 40 MB.
7. Existing checks stay green, run from openwhispr-mobile with Node 24:
   - `npx jest` (not `npm test`: its pretest step rebuilds better-sqlite3 in the shared node_modules)
   - `npm run typecheck`, `npm run lint`, `npm run format`, `npm run doctor`
   - `sh scripts/test-keyboard-direct.sh`, `sh scripts/test-keyboard-capitalization.sh`
   - `python3 plugins/keyboard-extension/tests/run-keyboard-touch-tests.py`
   - `bash modules/app-group-storage/tests/run-return-target-tests.sh` and `python3 modules/app-group-storage/tests/run-recording-startup-tests.py` whenever you change the App Group module
   - a simulator build

   Run targeted tests while iterating; leave the desktop suite and platform builds to PR CI.

8. Visual review: screenshots of each layout in light and dark, on SE and Pro Max, portrait and landscape, next to the iOS keyboard. No clipping, misalignment or contrast problems.

Benchmarks (before tuning anything)

1. Build each dataset from sources independent of the word and frequency lists you bundle. Split each into dev and test.
2. Commit them under openwhispr-mobile/plugins/keyboard-extension/tests/benchmarks/ and record each test split's SHA-256 in the ledger. Never edit a test split afterwards.
3. Tune only on dev; report only on test.
4. Keep engines (language model, autocorrect, swipe decoder, hit targets) in UIKit-free Swift files so they compile and test with plain swiftc. Bundled data needs a Resources build phase in withKeyboardExtension.js, with its Jest test updated.

Simulator and screenshots

- You are running in a terminal, with no tool that can tap or rotate the simulator. Use `xcrun simctl` only: build, install, boot, `io screenshot`, `ui appearance`, `openurl`, `launch`/`terminate`, `spawn defaults`.
- Use only these two simulators (iOS 26.5): kbq-SE, iPhone SE 3rd generation, UDID 261F1F4E-A08E-4EC2-9BE2-E465CDEE0ACB; and kbq-ProMax, iPhone 17 Pro Max, UDID 4B28D4FE-F5B5-409E-8407-A925CB10A84B. Both have the OpenWhispr Dev keyboard enabled with Full Access, plus Apple's English (South Africa), German QWERTZ and Emoji keyboards. Other sessions use the other simulators; don't touch those.
- Reference screenshots of Apple's keyboard (English, German, numbers, emoji; light and dark; portrait and landscape; at rest and with suggestions) are in /Users/chadpiha/Development/openWhispr/openwhispr/docs/superpowers/plans/2026-11-20-keyboard-apple-reference/, with a README that explains them and how to switch keyboards from the command line. In Setup, copy that folder to openwhispr-mobile/docs/keyboard-screenshots/apple-reference/ and commit it. Compare against these images instead of trying to capture Apple's keyboard yourself.
- `npx expo run:ios` fails on this Mac (Xcode 27.2 has no Simulator.app). Instead:
  1. `OPENWHISPR_APP_ENV=development npx expo prebuild --platform ios`
  2. Patch line 1 of the generated ios/OpenWhispr/AppDelegate.swift to `internal import BackgroundUploader`, after every prebuild (don't change the repo plugin).
  3. `xcodebuild -workspace ios/OpenWhispr.xcworkspace -scheme OpenWhispr -configuration Debug -sdk iphonesimulator -destination 'id=<udid>' -derivedDataPath ios/build/dd build`
  4. `xcrun simctl install <udid> <app>`
- Render your own keyboard for screenshots in the Mac Catalyst harness that run-keyboard-touch-tests.py builds: extend it to write one PNG per device size (SE 375 pt and Pro Max 440 pt wide, portrait and landscape), layout, appearance and state. Put each next to the matching Apple reference image. Use the simulators to check that the real extension builds, installs and loads; a screenshot of it on screen needs a text field focused, which you can't do without taps, so don't depend on it. `xcrun simctl ui <udid> appearance dark` switches appearance.
- Save screenshots under openwhispr-mobile/docs/keyboard-screenshots/, as compressed PNGs no wider than 1200 px. Keep ios/build under 20 GB and delete stale build output when it grows past that.

Loop

1. Order: freeze datasets and harnesses → language model and lexicon → layouts and languages → top bar → autocorrect → swipe → dynamic targets → trackpad → emoji → haptics → field settings and polish.
2. Each iteration: work on the earliest criterion in that order that isn't passing or blocked. Make one focused change, run the relevant tests and benchmarks, record the numbers, then update the table and the Next action line.
3. Revert a change only if it pushes an already-passing criterion past its threshold, or makes a metric worse without improving the criterion you targeted. A new feature may add memory and latency as long as criterion 6 still passes.
4. After 5 iterations without progress on a criterion, mark it blocked with evidence and move on.
5. Stop when every criterion passes or is blocked, or after 24 hours, whichever comes first.

Done
Whether you finished or hit the time limit, write a final report at the top of the ledger:

- the criteria table with numbers, and links to the screenshots
- where we're still behind the competitors
- everything under "Waiting on Chad"
- the Local-dictation research findings
- a short checklist for me to try on a real phone: haptic feel, swipe feel, trackpad feel, everyday typing in English and German

Leave everything committed on feat/mobile-keyboard-quality, unpushed.

## Working notes for resuming

- Work only in `/Users/chadpiha/Development/openWhispr/openwhispr/worktrees/keyboard-quality`. Setup step 1 commit: `bd9015a3e` on `feat/mobile-keyboard-direct-dictation`.
- Node 24: `source ~/.nvm/nvm.sh && nvm use 24` before npm/npx commands.
- Session start (wall clock): 2026-11-20, see the first log entry.

## Log (append-only)

### 2026-11-20 — Setup

- Committed the direct-dictation work as `bd9015a3e` (48 files, unchanged) on `feat/mobile-keyboard-direct-dictation`.
- Created `feat/mobile-keyboard-quality` in `worktrees/keyboard-quality`, symlinked `openwhispr-mobile/node_modules`, copied the Apple reference screenshots to `docs/keyboard-screenshots/apple-reference/`.

### 2026-11-20 23:11 SAST — Audit (work clock starts here; 24 h limit is 2026-11-21 23:11)

- Code read: `ios/KeyboardViewController.swift` (5,532 lines, one controller with private key/toolbar types), `tests/KeyboardTouchTests.swift` (appended to the controller file by `run-keyboard-touch-tests.py`, compiled for Mac Catalyst; a run takes about 2 minutes).
- Keys are `UIButton`s (`KeyButton`) with target-action; `KeyboardRowsStack.hitTest` gives each touch to the nearest key. There are key preview popups but **no long-press accents**. No suggestion bar, trackpad, emoji, spell checking, haptics, number pad or QWERTZ, as the prompt says.
- Baseline checks: touch tests 398/398, `test-keyboard-capitalization.sh` PASS, `test-keyboard-direct.sh` PASS. Both simulators are booted. npm registry and GitHub both answer.

### 2026-11-20 — Research pass (competitors)

Timing values for Apple's keyboard are not published; the ones below are unverified and need a phone check.

- **Apple** does best: transformer autocorrect with tap-to-revert on the underlined word, inline predictions, invisible key-target resizing, QuickPath swipe with delete-by-word, space-bar trackpad. Weak: iOS 26 wrong-key registration when typing fast (partly fixed in 26.4), over-eager corrections, the only reset wipes every learned word. Unverified timings: long press about 0.5 s, caps-lock double tap about 0.3 s, delete repeat about 0.5 s delay then 0.1 s.
- **Raycast** does best: a full typing keyboard (suggestion bar with words or emoji, autocorrect on space with tap-original-to-undo, slide to type, trackpad, drag-left on delete for words, haptic strengths, German as a download, autocorrect off in URL/email/username/search fields) and dictation that records in the keyboard from a button in the suggestion bar. Weak: falls back to opening the app when in-keyboard recording is unavailable; dictation is one small button, not the main action.
- **Superwhisper** does best: record button with waveform, modes. Weak: some buttons open the app and iOS 26.4+ doesn't return, typing reported as less accurate than Apple's, shift misbehaves. Whether it has autocorrect or swipe is unverified.
- **Wispr Flow** does best: sessions that keep the mic alive, accuracy and formatting. Weak: must open the app to start a session, feels less polished than the native keyboard.
- **Gboard/SwiftKey**: Gboard decodes taps and glides with a spatial model + lexicon + n-gram LM composed as FSTs under beam search; SHARK2 (Kristensson and Zhai 2004) matches a gesture against per-word templates by shape and location plus an LM. SwiftKey has undo-autocorrect-on-backspace as a toggle and types two languages at once on iOS.
- **Added to the plan from this:** keep the typed original in the suggestion bar's left slot so a correction can be undone with one tap as well as with backspace; a reverted correction is a negative signal (don't correct that word again); umlaut-insensitive matching for German (`fur` → `für`); delete a swiped word as a unit on backspace; preserve deliberate letter repeats ("soooo"). Not planned for this pass: haptic strength levels, simultaneous two-language typing, drag-left-on-delete (noted as gaps in the final report).

### 2026-11-20 — Data sources chosen

- **Bundled lexicon and language model** (built by our own scripts): Leipzig Corpora Collection 1M-sentence corpora (news, web, Wikipedia) for English and German (CC BY 4.0) plus Tatoeba sentences (CC BY 2.0 FR).
- **Benchmarks, independent of the bundle:** Universal Dependencies English-EWT and German-GSD (CC BY-SA 4.0) for sentences, over-correction and hit targets; Wikipedia's lists of common misspellings (English "For machines", German "Liste von Tippfehlern", CC BY-SA 4.0) for real misspellings; OpenSubtitles frequency lists (hermitdave/FrequencyWords, CC BY-SA 4.0) for the 10,000 most common words in the swipe benchmark.
- **Emoji:** Unicode `emoji-test.txt` and CLDR annotations (Unicode License v3).

### 2026-11-20 — Benchmarks frozen

- `tools/build-benchmarks.py` wrote the datasets; hashes are in "Benchmark test-split hashes" above. Sizes: English test sentences 19,231 tokens, German 13,616; misspellings 2,049 English and 64 German test pairs (the German Wikipedia list is short, so that figure is coarse: 1.6 points per word); 5,000 near-miss typos per language and split; 10,000 swipe words per language.
- Decisions made before any tuning: near-miss typos use words of three letters or more (a slip in a two-letter word is usually another real word); all-capitals tokens are left out; misspellings with several listed corrections are left out; German swipe results compare without case because the OpenSubtitles list is lower-case.
- Looked at and rejected for German misspellings: the GitHub Typo Corpus (per-repository licences, not one of the approved ones).

### 2026-11-20 — Local dictation in the keyboard: spike findings (research only, not built)

Spike: `spike/keyboard-local-speech`, commit `a2d126ed9`, worktree `worktrees/keyboard-local-speech-spike`, under `plugins/keyboard-extension/spike/local-speech/` (CLI, fetch script, references, per-clip results). Never merged.

**Design.** Record exactly as direct dictation does today (`WebAudioCapture.swift`, 16 kHz Int16 PCM), and at stop feed the finished PCM to `SpeechAnalyzer` + `SpeechTranscriber` (iOS 26+), then `SnippetExpander`, then insert. The analyzer's preferred format is 16 kHz Int16, the capture's own, so nothing is resampled. The app, not the keyboard, downloads the language asset through `AssetInventory` and writes "ready" into the App Group config. Everything else keeps the handoff: iOS below 26, an unsupported locale, "auto" language, a missing asset, any analyzer error.

**Measured on the Mac** (Apple Silicon, macOS 26.6.2; 15 FLEURS validation clips per language, real read speech, CC BY 4.0, 4 to 18 s each; no number normalisation, so "three" vs "3" is an error):

| Engine                             | Locale        | WER           | Real-time factor | Median per clip |
| ---------------------------------- | ------------- | ------------- | ---------------- | --------------- |
| SpeechAnalyzer + SpeechTranscriber | en-US         | 6.6% (18/273) | 0.017            | 0.12 s          |
| same, en-GB model on the US clips  | en-GB         | 7.7%          | 0.018            | 0.13 s          |
| SpeechAnalyzer + SpeechTranscriber | de-DE         | 3.3% (10/302) | 0.009            | 0.08 s          |
| DictationTranscriber               | en-US / de-DE | 14.7% / 12.3% | 0.02             | 0.15 s          |
| SFSpeechRecognizer, on-device      | en-US / de-DE | 20.9% / 39.7% | 0.022            | 0.15 to 0.19 s  |

- Memory: the CLI's own footprint peaked at 8 to 9.5 MB; the model ran in a separate `localspeechrecognition` XPC service (about 93 MB), which is the point of the design.
- Assets: en-US was already installed; de-DE took a 27 s download. An app can reserve at most 5 locales.
- SDK check: the iPhoneOS 27.2 SDK marks nothing in Speech.framework as unavailable to app extensions (SpeechAnalyzer, SpeechTranscriber, AssetInventory, SFSpeechRecognizer). That is a compile-time answer only.

**What it would lose against the app's Local path:** AI cleanup and tone (the text is punctuated and capitalised but otherwise raw); the custom dictionary (`contextualStrings` showed no effect in three tries); it is a different engine from the user's chosen Whisper or Parakeet model. Snippets, the no-speech check and capitalisation stay.

**Info.plist and entitlements:** no entitlement was needed on the Mac. SpeechAnalyzer asked for no authorization there, so the extension should be tried without `NSSpeechRecognitionUsageDescription` first; only SFSpeechRecognizer needs it. `RequestsOpenAccess` is already true and recognition makes no network call.

**Works inside a keyboard extension: NEEDS A PHONE TEST.** To check on a device, from inside the extension: `isAvailable` and locale support (en-ZA included); whether an asset the app installed reads as installed; a full transcription with Full Access on and off; whether any speech authorization prompt is needed; no entitlement denials in the console; where the model's memory is charged, and jetsam on a 5-minute take; cold and warm latency; `insufficientResources` under memory pressure; accuracy on WebKit-captured audio; airplane mode.

**Risks:** iOS may refuse the XPC service to a keyboard or charge its memory to the extension; asset reservation may not carry from app to extension; phone speed is unmeasured; artefacts go straight into the text (one German clip ended "Ergebnis.nis."); the sample is 30 clips. The decision to build it is Chad's.
