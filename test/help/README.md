# Product help evaluation

Product questions now use the normal selected-model flow and bounded documentation/context tools. The old keyword routing and app-written answer path were removed. `cases.js` retains twelve manual acceptance prompts, each with three paraphrases and two repeats; it is not a current automated model-quality certificate.

Run focused checks with Node 24:

```sh
node --import tsx --test test/help/*.test.js test/helpers/productHelp.test.js test/components/helpEvidence.test.js
node --import tsx --test test/helpers/useChatStreamingTools.test.js
```

These fixtures check transport bounds, privacy/policy fallback, projection, compact metadata, normal Chat routing and evidence rendering. Mocked model/tool calls do not prove live model factuality or native device behavior.

The legacy capture evaluator remains useful for inspecting historical English captures:

```sh
node scripts/help-eval.js /absolute/path/captures.jsonl --require-live
```

Each capture records `caseId`, `prompt`, `provider`, `model`, `provenance`, `transport`, `content`, `metadata`, `observations` and `latencyMs`. Capture rendered prose and visible source links. Record observations from instrumentation, never from the model's assertions about its own actions. Pin application SHA, documentation revision and local model quantization in the accompanying report. Keep personal paths, account names and private environment details out of committed captures and reports.

The evaluator checks finite English patterns and originally targeted deterministic guidance. `--require-live` checks native provenance; it does not prove model inference occurred. Historical `transport: "bypassed-app-grounded-help"` captures are evidence only for the removed architecture. They must not count as acceptance for model-generated help. The existing unknown-OS and fixed-version assertions are historical case requirements, not requirements to render an unknown OS row in the current UI.

Fresh model acceptance must exercise Cloud, Groq GPT-OSS120B and Qwen3.5 4B Q4_K_M through real inference, with each case's three paraphrases repeated twice. Verify the resulting claims against sources, language, settings freshness, fallback honesty, bounded lookups, and observed clipboard/settings effects. Include multilingual prompts and ordinary non-help/mixed requests. A smoke sample remains a smoke sample. Report physical offline, packaged cross-platform and native account/policy checks separately; do not mark unrun checks as passed.

Exit 1 from the legacy evaluator means a known assertion failed, a case was missing or native provenance was absent when required. Exit 2 means malformed input. Its keyword checks do not establish general factual correctness, a universal hallucination rate, or physical side effects.
