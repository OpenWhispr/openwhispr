# Product help acceptance cases

Run the application-boundary regression suite:

```sh
node --import tsx --test test/help/*.test.js
```

`cases.js` converts all twelve 2026-10-07 native-QA specifications into three paraphrases with two consecutive runs each. `groundedHelp.test.js` executes the actual app-controlled routing/answer code against injected settings and documentation dependencies. It changes the shortcut between runs, injects malicious retrieved prose and malformed source paths, simulates documentation/context failure, and checks cancellation. It verifies factual fields, supported-answer coverage, deliberate abstention and bounded read-only dependencies separately. This is synthetic application-boundary proof; the hook and UI need their own delivery and rendering tests.

Evaluate saved provider/native output without accessing credentials:

```sh
node scripts/help-eval.js /absolute/path/captures.jsonl --require-live
```

Each line is a JSON record. Capture complete rendered answer text (including the visible settings and Markdown source links), not only the message's prose. `metadata` contains the message's grounded-help metadata. Use factual observations from instrumentation; do not copy a model's claim that it did not change anything into observations.

```json
{
  "caseId": "fresh-settings",
  "prompt": "What is my dictation shortcut currently set to?",
  "provider": "groq",
  "model": "openai/gpt-oss-120b",
  "provenance": "live-native",
  "transport": "bypassed-app-grounded-help",
  "content": "Dictation shortcut: Control+Alt+K",
  "expectedShortcut": "Control+Alt+K",
  "metadata": { "answerStatus": "answered", "sources": [] },
  "observations": { "freshContextRead": true },
  "latencyMs": 42
}
```

Required capture fields depend on the case:

- `fresh-settings`: `expectedShortcut`, observed `freshContextRead`.
- `no-side-effects`: observed `settingsUnchanged`, `externalPasteUnchanged`, `readOnlyTools`.
- `invalid-page`: observed `lookupCount` and `invalidSourceExcluded`.
- `citation-support` and `docs-outage`: structured `metadata.sources` and the rendered clickable links in `content`.
- Every capture: exact provider/model, provenance (`live-native`, `live-provider`, or `synthetic`), prompt and case ID. Pin application SHA, documentation source/revision and local model quantization in the enclosing evidence report.

Exit 1 means a known regression failed, a case was missing or `--require-live` found non-native captures. Exit 2 means malformed input. The report includes per-provider/model counts, distinct paraphrases, abstentions, missing cases, failures, latency and transport separately. Run every case across Cloud, Groq GPT-OSS 120B and Qwen3.5 4B Q4_K_M, with three paraphrases and two repeats, before claiming that matrix complete. A small smoke sample remains a smoke sample. Provider transport being bypassed for deterministic product help is expected; test unrelated model chat separately to establish its transport works.

The evaluator checks known forbidden inventions and required facts. It explicitly leaves general factual correctness unassessed: matching keywords does not prove all statements are supported. It does not claim a universal hallucination rate or prove physical native side effects from synthetic fixtures. Do not mark an unrun provider/model or physical offline test as passed.
