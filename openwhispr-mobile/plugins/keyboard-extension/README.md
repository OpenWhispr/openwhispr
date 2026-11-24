# keyboard-extension (Expo config plugin + iOS extension target)

A custom iOS keyboard extension that lets the user dictate from any text field system-wide. Its keys look and type like Apple's keyboard; the toolbar above them holds the tone menu, the dictation pill and the agent button, and while a word is typed the pill makes room for three suggestions. Typing help (autocorrect, suggestions, swipe typing, learned words, emoji) runs on the device in English and German; see [Typing](#typing). Tapping **Tap to speak** records in place through the OpenWhispr app's background session; only when that session has gone stale does the pill read **Activate** and hand off to the app.

## What's here

| File                                                                                                                                                                               | Role                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withKeyboardExtension.js`                                                                                                                                                         | Expo config plugin. Runs at `expo prebuild` time and adds the keyboard target to the generated Xcode project, links the entitlements, and configures the App Group capability.                     |
| `ios/KeyboardViewController.swift`                                                                                                                                                 | The keyboard UI and lifecycle. Reads/writes shared state through the App Group `UserDefaults` suite (see [`modules/app-group-storage`](../../modules/app-group-storage/)).                         |
| `ios/Direct*.swift`, `ios/WebAudioCapture.swift`, `ios/SnippetExpander.swift`, `ios/KeyboardCredentialStore.swift`                                                                 | Dictating in the keyboard without the app (step 4 below).                                                                                                                                          |
| `ios/KeyboardCapitalization.swift`                                                                                                                                                 | When shift turns on by itself, following the field's autocapitalization type. Foundation-only, so it is unit-tested on macOS.                                                                      |
| `ios/Typing*.swift`, `ios/Autocorrector.swift`, `ios/SwipeDecoder.swift`, `ios/HitTargetModel.swift`, `ios/TrackpadModel.swift`, `ios/KeyGeometry.swift`, `ios/EmojiCatalog.swift` | The typing engines. Foundation only, so they build and test with plain `swiftc` (`scripts/test-keyboard-typing.sh`).                                                                               |
| `ios/SuggestionBarView.swift`, `ios/KeyboardInteractions.swift`, `ios/EmojiPanelView.swift`                                                                                        | UIKit pieces: the suggestion bar, accent row, swipe recogniser and key feedback, and the emoji panel.                                                                                              |
| `ios/Resources/`                                                                                                                                                                   | Bundled data: `lexicon-en.bin`, `lexicon-de.bin` (built by `tools/build-lexicon.py`) and `emoji.bin` (`tools/build-emoji.py`). Sources and licences are in [`data/LICENSES.md`](data/LICENSES.md). |
| `tools/`                                                                                                                                                                           | Data builders (`fetch-sources.sh` downloads the corpora into the git-ignored `data/.cache`), the benchmark builder and the screenshot comparison tool.                                             |
| `ios/Info.plist`                                                                                                                                                                   | Extension Info.plist (display name, RequestsOpenAccess, etc.)                                                                                                                                      |
| `ios/OpenWhisprKeyboard.entitlements`                                                                                                                                              | App Group capability entitlement                                                                                                                                                                   |
| `tests/`                                                                                                                                                                           | Swift tests: the capitalization rule, and UIKit touch routing across the real keyboard layout.                                                                                                     |
| `__tests__/`                                                                                                                                                                       | Jest tests for the config plugin's Xcode project wiring.                                                                                                                                           |

## How it works

1. User installs the keyboard from iOS Settings → General → Keyboard → Keyboards → Add New, and turns on Allow Full Access.
2. User opens any app, switches to the OpenWhispr keyboard and taps the pill.
3. **In place.** When the app's background session is ready (`isBackgroundSessionReady()`), or when the keyboard is inside OpenWhispr itself, the pill reads **Tap to speak**. A tap writes a start request to the App Group and posts a Darwin notification. The app records without leaving the host app, the keyboard shows a recording canvas, and it inserts the transcript when `transcriptReady` arrives.
4. **In the keyboard (iOS 26+).** When the app isn't running and Preferences → Keyboard → **Dictate without opening OpenWhispr** is on, a signed-in OpenWhispr Cloud user's tap records in the keyboard itself: a hidden `WKWebView` holds the microphone (`WebAudioCapture.swift`; a keyboard extension is refused native recording), the take is boosted, encoded as AAC and sent to `/api/transcribe` with the session the app shares through the App Group keychain (`DirectDictation.swift`, `DirectDictationRuntime.swift`). A Local Mode user on Parakeet dictates in the keyboard too: the take never leaves the phone. `KeyboardParakeetTranscriber.swift` loads the model the app downloaded into the App Group onto the Neural Engine with FluidAudio (never the GPU, never a download; it keeps a model only once it's on the Neural Engine and while the keyboard has room for it), starts loading when the keyboard appears, and lets go of it on a memory warning once no transcription needs it. Until the model is ready, a tap hands off to the app. The app's snapshot (`keyboard_direct_config`, written by `src/lib/keyboardDirectSync.ts`) decides when this is allowed; Bring Your Own Key, Whisper in Local Mode, a custom cleanup prompt, guests, the assistant, and dictating while other audio plays or over Bluetooth keep the handoff. Each dictation leaves a record in the App Group's `direct-dictations/` folder, which the app turns into History (`src/lib/keyboardDirectOutbox.ts`). Its Swift tests run with `npm run test:keyboard-direct`.
5. **Handoff.** Only when neither of those applies does the pill read **Activate**. Its link opens `<scheme>://keyboard-dictation` (handled by [src/hooks/useKeyboardHandoff.ts](../../src/hooks/useKeyboardHandoff.ts)). The app starts a native recording, then sends the user back to the host app (`returnToHost` in [src/lib/handoffReturn.ts](../../src/lib/handoffReturn.ts)). iOS 26.4+ hides the host from the extension, so the containing app learns it from UIKit ([`HostAppObserver.swift`](../../modules/app-group-storage/ios/HostAppObserver.swift)). When no host is found, the app shows the "Swipe back to your app" screen instead. The transcript is pasted on the keyboard's next focus.

## Typing

Everything here runs on the device. Keystrokes and typing history never leave the phone or reach the logs, and learned words stay in the App Group container. Without Full Access none of it loads and the keyboard types plainly.

- **Languages and layouts.** English and German, QWERTY and QWERTZ (German has umlaut keys on either). The app's Preferences → Keyboard typing sets both; a long press on the emoji key switches them from the keyboard. Stored in the App Group (`keyboard_typing_language`, `keyboard_typing_layout`); unset, they follow the device's preferred languages, and typing help is on only when one of them is English or German. A third language choice, "Other (no typing help)" (`keyboard_typing_language` = `other`), is for languages without a word list: suggestions, autocorrect, swipe and smart key targets are off, and the keys, haptics and trackpad stay. "Français (Suisse)" (`fr_CH`) is the same without typing help, with è, é and à on keys of their own where German has its umlauts (QWERTZ unless a layout is chosen).
- **Autocorrect and suggestions.** `TypingSession` follows the text and answers each key with the edit to make; `Autocorrector` scores candidates from the bundled lexicon (word and word-pair frequencies), learned words and iOS's supplementary lexicon (text replacements, contact names). A correction is made at a word boundary and backspace takes it back. Fields that ask for none get none: autocorrection or spell checking off, URL and email keyboards, user names, passwords, one-time codes, and fields that hide their text (which are never learned from).
- **Suggestion bar.** Two layouts behind `keyboard_suggestion_bar_style`: `strip` (default) shows the suggestions between the tone and assistant buttons while a word is typed, with dictation as a 44 pt mic button; `row` adds a suggestion row above the toolbar. `TypingSettings.defaultBarStyle` picks the default.
- **Swipe typing**, **dynamic hit targets** (the touch boundary between letters leans toward the likelier next letter; the inner 60% of a key always types it), **space-bar trackpad**, **long-press accents**, a **number pad** for number fields, **haptics** (a light tap per key; `keyboard_haptics_enabled`), and an **emoji panel** with search, skin tones and Recents.
- **Benchmarks.** `tests/benchmarks/` holds the frozen datasets (see its README); `sh scripts/test-keyboard-typing.sh autocorrect|swipe|targets …` runs them, and with no arguments runs the engines' unit tests. Tune on `dev`, report on `test`.

## Apple capabilities required

- **App Group** (`group.<ios bundle id>`) — must match between the main app, the extension, and the `app-group-storage` module. The app keeps its Parakeet models there too, at `Library/Application Support/SpeechModels/<folder>` (`parakeet-tdt-0.6b-v2`, `parakeet-tdt-0.6b-v3`, the folder names FluidAudio loads from; see [`modules/parakeet-asr/ios/SharedSpeechModels.swift`](../../modules/parakeet-asr/ios/SharedSpeechModels.swift)), excluded from backup and moved there from the app's own container by builds that predate it.
- **Open Access** (`RequestsOpenAccess` in `Info.plist`) — required for the extension to read/write the shared suite.

## Environments

Runtime identifiers are resolved from `config/openwhispr-environments.js` and applied by `app.config.js` plus this plugin during prebuild.

- Production/TestFlight: `OPENWHISPR_APP_ENV=production`
- Development: `OPENWHISPR_APP_ENV=development`
- Local signing override: set `OPENWHISPR_IOS_BUNDLE_IDENTIFIER` and `OPENWHISPR_SCHEME` when needed. The App Group defaults to `group.<OPENWHISPR_IOS_BUNDLE_IDENTIFIER>`.

Verify with:

```bash
OPENWHISPR_APP_ENV=development npx expo config --json
```

After changes, regenerate the native project:

```bash
OPENWHISPR_APP_ENV=development npx expo prebuild --clean
npm run ios
```

## Tests

```bash
npm run test:keyboard-capitalization # capitalization rule (macOS, needs Xcode's swiftc)
npx jest plugins/keyboard-extension # config plugin
```

Mobile CI runs both, and the touch regression tests below, on pull requests that change `openwhispr-mobile/`.

## Simulator harness

`python3 plugins/keyboard-extension/tests/run-keyboard-sim-harness.py <simulator udid> --tests | --perf | --screenshots <dir> --device <se|promax>` builds the production keyboard sources and the tests as a small app (plain `swiftc`, no Expo build), runs it in the simulator and prints the result: the typing checks on a real iOS, latency and memory figures, and screenshots in true light and dark. `tools/compose-keyboard-comparisons.py` stacks those screenshots under Apple's reference shots.

## Keyboard touch regression tests

On macOS with Xcode:

```bash
python3 openwhispr-mobile/plugins/keyboard-extension/tests/run-keyboard-touch-tests.py
```

Run it from the repository root after changing the keyboard layout, its padding or key targets; mobile CI runs it too. The runner compiles the production keyboard Swift sources for Mac Catalyst, so it needs no simulator, signing credentials or Expo build; it stubs what iOS would tell the keyboard (the field behind it, the globe key, a phone or an iPad, landscape). It tests UIKit hit routing across row gaps, overlapping key targets, unequal key widths, nested stacks, hidden layouts, disabled keys and keyboard boundaries, then lays out the real keyboard at every iPhone width in portrait and landscape, on all three pages, with and without the globe key, on iPad, and with the URL, email, web search and Twitter bottom rows and a greyed return key, and checks that no tap below the dictation strip is dropped, the keyboard's padding included. It also checks shift after letters and deletes, smart quotes per field, the return key and Twitter rows per page, rotation, the globe key settling late, a view shorter than the keyboard, and the review card's extra height.

These touch tests do not measure typing latency. Before releasing,
check fast two-thumb typing and repeated letters on an iPhone, near-edge taps,
Shift, 123/ABC, space/return, held delete, keyboard switching, and dictation in
portrait and landscape in Notes and another host app.

## Reference

- [Apple — Custom Keyboard Extensions](https://developer.apple.com/documentation/uikit/keyboards_and_input/creating_a_custom_keyboard)
- [Apple — App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups)
