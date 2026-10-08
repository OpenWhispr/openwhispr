# Local selected-text editing repair — 6 October 2026

Latest: [6 October independent-review repairs and validation](review-repairs.md). The original qualification below remains historical; model quality and native acceptance are still open.

Question: can a strict response contract and dedicated local edit request fix the observed refusal without accepting incorrect edits as proven correct?

**The response contract is repaired; Qwen 3.5 2B edit quality remains insufficiently reliable. This branch is a draft for engineering review, not release acceptance.** All model fixtures/results here are synthetic. No real note, selection, dictionary, account, or audio was used.

## Changes and bounded proof

- Shared marker prompt now places the exact nonce inline at the end of its instruction, with no demonstrated period or newline. Periods, partial/wrong/duplicate markers and trailing junk remain invalid. Format and empty-output failures have typed errors distinct from truncation.
- Bundled local selection editing uses a dedicated prompt and schema-constrained one-field JSON response. The field is forwarded through renderer config, IPC, local bridge, model manager and llama-server. Strict parsing rejects ambiguous envelopes; decoded text retains quotes, whitespace and literal thinking tags. Default cleanup/chat requests have no schema.
- Only a confirmed `stop` with real answer content can supply a structured edit. Reasoning-only, unknown completion and truncated responses fail. Validation precedes session banking; cancellation, capture/session/target checks remain.
- Explicit custom Assistant preferences and dictionary hints are subordinate to the requested edit. The ordinary dictation prompt and automatic language/script conversion no longer alter a local edit. Other providers retain their existing marker route with the corrected contract.

- Wake-address removal for local edits now splices only the original address span, preserving punctuation, repeated whitespace and decomposed Unicode in literal operands. Existing conversational address handling is unchanged.
- Streaming and batch selection failures retain provider parameters/recovery details and a localized selection-failure title.

## Model qualification

- Model: `Qwen_Qwen3.5-2B-Q4_K_M.gguf`, SHA-256 `57a1085840f497d764a7fc5d346922dbde961efb54cc792ea81d694fd846a1d8`.
- Server: packaged binary executed read-only in a separate process, `b9763-dec5ca557`, context 16384, temperature 0.2, output cap 8192, thinking disabled, local loopback only. This process did not change the installed app or its server/settings.
- Qualification-time helper SHA-256: `d613505086ba46a2964524560885cc7855df05b9c8f88b61d2b138323cc92d7f` (also in every result row); later commits changed that file. The stable identity is the prompt SHA-256 `f3dffdd0f7ab198b5f094cf1f5fe85b9a618e1ebcffbfe3653876835a8e2dc60` in every row, which still matches the shipped local prompt. No prompt edits after qualification began.
- The first development prompt produced 17/17 valid envelopes but only 2/17 exact edits, largely by retaining JSON wrapper quotes. A shorter prompt with an explicit decoding instruction and one replacement example improved this to **15/17 exact**, **17/17 format** (seed 73). Those are prior-investigation cases, not unseen qualification.
- An independent agent authored 18 new cases before the prompt freeze. Final qualification: **26/36 exact**, **36/36 format**, seeds 113 and 127. Exact scoring uses byte-for-byte string equality with no trimming or punctuation forgiveness. Every case was run once per seed; no retry substitution. The fixture's suggested seeds were superseded by these recorded run seeds before execution.
- Failures repeated across both seeds: Markdown table corruption (qualify_02), uppercase `MAÑANA` misspelled (09), extra quote after literal thinking-tag content (13), dropped `/status` URL path (17), and corrupted 6000-code-point document (18). These valid JSON strings would still be eligible for automatic replacement; schema validity does not establish edit meaning.
- The old development deletion case still leaves part of the requested phrase. The old single-word case emits `Approved` without the fixture's final period (the earlier investigation allowed either; this evaluation deliberately uses strict equality). No product-wide statistical reliability claim follows from this small synthetic set.

The model-quality objective is **not met**. Do not merge this as a claim of reliable Qwen 2B automatic rewriting. Choosing a larger model or adding a user review step needs a separate product decision; this repair changes neither the default model nor the UI and never falls back to cloud.

The output dialect is documented by [llama.cpp at the tested server revision](https://github.com/ggml-org/llama.cpp/blob/dec5ca557/tools/server/README.md#post-v1chatcompletions-openai-compatible-chat-completions-api).

## Validation

- Baseline regression tests failed on the original marker demonstration/error and absent structured contract. The corresponding final tests pass.
- Focused suite: 244/245 initially passed; the existing unmapped-PID test exceeded its 3-second wall-clock limit under concurrent load. Isolated rerun: 17/17 in that file. The full suite also passed that test.
- Final full `npm test`: 7201 tests, 6909 passed, 291 skipped, 1 todo, 0 failures. The 98-test repair-focused suite also passed.
- Node 24.20.0; `npm run typecheck`, `npm run format:check`, `node scripts/check-i18n.js`, `npm run build:renderer` passed. Existing lint warnings in icon primitives and build chunk warnings remain. Dependencies were refreshed only in the isolated worktree; lockfile unchanged.
- Actual isolated Electron renderer `ReasoningService` → local provider → preload/IPC → local bridge → model manager → packaged server → strict decoder: passed the original synthetic replacement case (`native-renderer-chain.json`); a direct IPC probe also passed (`native-local-chain.json`). This is real inference/IPC proof, not saved-text/undo proof.
- An isolated app/cache root in a temporary directory loaded the unmodified app entrypoint and freshly compiled native helpers. Production profile and installed application remained unchanged. Native UI automation selected synthetic text in a new TextEdit document, but foreground target capture continued to observe another app; no edit was banked or pasted. Do not count this as native target acceptance. Notes editing, saved-text/undo, spoken audio, cleanup-on/off native controls, focus-race/same-app-field tests and packaged/cross-platform acceptance remain open.

## Reproduce the model check

Use an owned, idle loopback server with the identity above. The runner never starts/stops a server or captures/pastes a selection. All output paths must be new.

```sh
node scripts/selection-edit-eval/run.mjs
node scripts/selection-edit-eval/run.mjs --run --seeds 73 --out /tmp/new-regression.jsonl
node scripts/selection-edit-eval/run.mjs --run --fixtures scripts/selection-edit-eval/qualification.json --seeds 113,127 --out /tmp/new-qualification.jsonl
```

The default endpoint is `http://127.0.0.1:18229`; override with `--endpoint` only for an owned loopback server. Future prompt tuning makes the current qualification set development material and requires a new reserved set. Seeds, process state, caching and hardware do not guarantee identical generation.

Independent native Codex review of `f770e9211..4ada84ca8` found two P2 defects: wake-address normalization changed literal operands, and streaming dropped error parameters. Both were repaired, with 98/98 focused tests and independent follow-up review finding no further actionable defects. Eight additional Unicode/whitespace probes and real German translation rendering passed. The reviewed seven-file repair diff SHA-256 is `1aefbbacef64a259cc6eb4790763ce05ea9f526d1f8008f7a1cc5dd496591f4c`. Final CI is recorded in the handoff/PR. This report itself is not merge or release approval.
