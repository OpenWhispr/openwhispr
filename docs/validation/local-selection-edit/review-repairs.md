# Independent review repairs — 6 October 2026

PR #2523 remains draft. This follow-up repairs the three confirmed code regressions at `47329acac90d4fed20da7b71c08326d0280650ec`; it does not qualify Qwen for reliable automatic edits or close native saved-text/undo acceptance.

## Changes and evidence

- The completion marker is inline at the end of the instruction, with no demonstrated period or newline. The extractor is unchanged: it removes only the exact marker, preserves document whitespace, and rejects missing, wrong, duplicate or trailing-junk markers.
- Wake-address matching refines the prefix within the first detected name boundary. `B. OpenWhispr` retains `B.`, including short numbers/emoji and fuzzy/split names. It cannot extend a misspelled name over a following operand (`OpenWhisp, R.`), and quoted CJK wake routing is retained. Hotkey instructions remain untouched. Tests exercise actual AudioManager requests and captured-session banking.
- Existing non-local empty/truncated message keys map to the existing selection-specific recovery copy. The original error remains intact; authentication/network/busy codes, parameters, settings actions and technical details survive. Failed edits never bank a replacement or fall back to ordinary dictation.

Every finding was reproduced before correction. Four new/changed regression checks failed on the reviewed head; the repaired focused set passes. The independent wake reviewer also found two defects in the first repair (suffix operand loss and quoted Japanese routing). Both were reproduced, fixed and re-reviewed; the initial review remains preserved.

Code revisions: first repair `64147a39a2ca24263958252a19e4cc82e7bc8595`, final wake correction `5923c0c2d6b06cbf2ee11d50f047e6dd67365700`. The original PR base remains `f770e9211719a6e28d0578b480d8a23dea79d7ff`.

## Bounded live cloud comparison

[Full requests, raw responses and banking results](review-repairs-cloud.jsonl) use the real AudioManager and OpenWhispr renderer adapter with an HTTP bridge replacing Electron IPC. Both members of each pair use the same nonce, synthetic input, English assistant template, actual auto-language instruction, empty custom preferences/dictionary and backend. Pair order alternates. The backend identified `parasail-gpt-oss-120b-openwhispr`.

Four cases (exact replacement, whitespace no-op, final-newline no-op, Markdown edit), two repeats each:

| Final matched sample                 | Reviewed head | Final repair |
| ------------------------------------ | ------------- | ------------ |
| Exact replacement bytes              | 1/8           | 6/8          |
| Valid marker and banked session      | 7/8           | 8/8          |
| Unwanted boundary newline            | 6/8           | 0/8          |
| Legitimate final-newline cases exact | 1/2           | 2/2          |

The repaired non-exact responses changed a tab into literal `\t` and removed a Markdown table space. These are incorrect but valid model outputs, still eligible for banking. This small development sample is not an unseen qualification or a product-wide success rate. No trimming or semantic-output repair hides either miss. The reviewed-head invalid-marker response was rejected and not banked.

The original fresh baseline reproduced the regression: reviewed head 0/6 exact with added LF in all six; original base 4/6 exact, one invalid marker and one Markdown spacing miss. Three intermediate prompt candidates were retained in the complete handoff evidence: an example-only candidate fabricated a nonce, a repeated example gave 6/8 exact but one duplicate terminal LF and one Markdown corruption, and a verbose inline candidate gave 4/8 exact. Only the final concise prompt above matches the final code. No favorable retries replaced failed rows.

Across the complete investigation, 71 bounded synthetic cloud inference calls returned HTTP 200. Each of five successful test logins was signed out (HTTP 200). Final ordinary controls returned cleanup text, German translation and standalone answer `4`. These are adapter/inference controls, not physical dictation or multi-turn chat acceptance. Credentials were read into memory only.

## Other providers and remaining quality limits

The independent 51-case real-renderer matrix covers all 13 non-local provider IDs with synthetic boundary responses: valid edits, wrong markers, empty replies and truncation. Actual vendor services were not called except OpenWhispr Cloud. Source/fixture coverage is not live vendor proof; Cloud's success-plus-empty shape remains an invalid response because it supplies no keyed empty-output error.

[Custom/LAN live results](review-repairs-selfhost.json) use the actual adapters against an owned loopback Qwen server. Both final selected edits added a trailing space (0/2 exact); both ordinary cleanup controls were exact. This is a measured local-model limitation, not native acceptance. The separately recorded initial server configuration left thinking-tag wrappers in the custom output and was corrected to disable thinking before the final sample; neither sample is discarded.

Qwen model SHA-256 remains `57a1085840f497d764a7fc5d346922dbde961efb54cc792ea81d694fd846a1d8`, packaged server `b9763-dec5ca557`, context 16384, cap 8192, temperature 0.2, final seed 113, thinking disabled. The dedicated bundled-local prompt and JSON schema are unchanged. Prior semantic results remain unresolved: qualification 26/36 exact (36/36 valid), regression 15/17 exact (17/17 valid), independent reproduction 13/18 exact (18/18 valid). Valid structure does not establish correct editing.

## Verification and scope

Final `npm test` at code `5923c0c2d`: **7204 total, 7184 passed, 0 failed, 19 skipped, 1 todo**, 168.9 seconds. Node 24.20.0, installed Electron and Node-compatible better-sqlite3; in-memory SQLite smoke check passed. Typecheck, lint/format, all 11 locale key/placeholder checks and renderer build passed. Existing icon lint warnings and build chunk warnings remain. Generated `src/dist` was deleted.

The primary shared focused run passed 304 tests before the final wake correction; the final full suite includes those paths. Three independent reviewers approved their final scopes at `5923c0c2d`: cloud contract/evidence; wake routing/request/banking; provider errors/shared journeys. Their additional evidence includes 83 wake/request/routing rows, 13,230 differential detection cases with zero boolean changes, 51 provider adapter cases and 16 error-factory/revision cases. These overlap and must not be added to the full-suite count. No actionable review finding remains in these repairs.

Dependency manifests are unchanged from the original base. The pre-push CI run passed its test step but failed the inherited dependency-audit gate; the new head's CI must be read separately. CI status is recorded in the final handoff rather than treated as local-test proof.

No merge, deployment, release, GitHub review/comment, default-model switch, cloud fallback, dependency update, production profile/app modification or native document edit was performed. CI's inherited dependency-audit problem remains separate. The target/session/cancellation guards and known same-app identical-text limitation are unchanged. Native persisted text, one undo, real wake/hotkey, cleanup-on/off, focus/expiry/new-recording races, clipboard restoration and physical-platform acceptance remain open.

Full reproduction scripts, all attempted prompt results, independent reviews, logs and lifecycle receipt are preserved in the author's handoff evidence (kept outside this repository).
