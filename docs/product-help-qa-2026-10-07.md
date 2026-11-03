# Product-help review and evidence — 7 October 2026

PR #2517 originally used tools to answer product questions, then introduced deterministic English interception as a repair. Chad's review found that interception bypassed the selected model, misclassified ordinary requests and made the recorded provider matrix misleading. The current repair removes the interception and restores model-generated answers using bounded read-only help tools.

## Current repair

- Ordinary chat, note actions and mixed requests keep the existing model flow. Product-help tool instructions request the user's language, current settings, official sources and explicit uncertainty.
- Documentation requests use curated paths and bounded transport; privacy and policy checks control online access. Malformed paths cannot become arbitrary external requests.
- Current settings exclude private device names and duplicate display labels. Durable tool metadata retains compact sources and timestamps, not articles or settings snapshots. Answers remain normal conversation content.
- Source and failure labels and all three tool names are translated. Legacy evidence cards use stable field keys, human-readable shortcuts and values, distinguish microphone permission from input selection, omit unknown OS version, and start collapsed. Evidence is outside the Voice Assistant selection area.
- Product and evaluation documentation now describe the model/tool architecture. This committed report contains no personal filesystem paths, account names, environment hashes or private rig identifiers.

Three implementation agents handled blockers, backend/tool should-fixes, and UI/localization/nits. A separate pass by the blocker agent reviewed the backend changes and caught the renderer short-circuit that initially prevented cached-policy fallback; that issue was repaired and covered by tests.

### Current automated verification

- Node 24 full test suite with required database tests: 7,217 passed, zero failed, 19 skipped and one todo (7,237 total).
- Quality checks (ESLint, Prettier and TypeScript) and locale-key/placeholder checks passed. The two existing Fast Refresh warnings in `icons/primitives.tsx` remain unrelated.
- Renderer production build passed. Generated output was removed after verification.
- Final prompt wording also passed the focused system-prompt suite. Fixtures cover mocked model flow, tool boundaries and component behavior; they do not establish real provider answer quality or physical/native behavior.

### Review disposition

- **Blockers:** removed automatic keyword interception on every surface. Ordinary, multilingual, follow-up, note, container, selected-text, screenshot and onboarding turns retain the normal model flow. English bundled text is only model reference material. Unsupported catalog topics may use official-docs web search when offered.
- **Should-fix:** removed nonexistent menu advice and the fixed-answer network wait; restored normal automatic delivery; distinguished unavailable policy from explicit denial and reused account-bound cached policy. Signed-out and fully-local configurations avoid remote help lookups; disabled assistant/web-search policy is respected. New tool metadata saves neither article bodies nor settings snapshots; microphone device names are omitted. Tools are bounded, remote excerpts are marked untrusted, and onboarding/unsupported models do not receive help tools. Historical evidence cards have readable labels, collapsed settings and separate selection behavior. QA details were sanitized, locale spelling corrected, and tool display names translated.
- **Nits:** consolidated the documentation origin and bundled fallback, adapted legacy labels to stable keys, removed the unused interception revision/exports/duplicate fields, used the app-version helper, added explicit return types, fixed touched lint/formatting issues and filtered the historical synthetic tool name from model history.
- **Branch-name exception:** the existing `codex/product-help-v1` PR head is retained. GitHub closes an open PR when its head branch is renamed ([GitHub documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/renaming-a-branch)). Replacing the PR solely for its branch name is left for a separate decision.

A passing fixture or typecheck does not establish live model factuality, physical device behavior or released behavior.

## Historical evidence: superseded architecture

These observations are retained only to explain the previous tests and their limits. They have not been rerun for the current architecture.

- Original QA used PR head `f27bf30403d5c3f7d73c5decaf14549858edc858`. The deterministic repair incorporated main `a1cdf62ac`.
- A 72-turn synthetic matrix and later 216-turn native macOS matrix covered twelve cases, three paraphrases and two repeats with Cloud, Groq GPT-OSS120B and Qwen3.5 4B Q4_K_M selected. Product answers were app-written and bypassed those models. Separate generation smoke checks established only that inference worked.
- Native matrix behavior was pinned to `00ff9066892c59ee54d72d21d0d0d752b6629263`. Scoped documentation faults exercised unavailable, missing-page and malicious-page outcomes; four rate-limited fault cases were later repeated successfully. These simulated faults did not establish physical network-off operation.
- Freshness checks changed and restored shortcut and activation settings. Typed Chat tests preserved a synthetic external document and clipboard. An initial spoken clipboard discrepancy was unexplained; a later controlled physical voice repeat preserved both document and text clipboard. This was bounded macOS evidence for the removed interception path, not a general clipboard guarantee.
- A Keychain prompt interrupted one attempted native outage run. That attempt was not counted as passed and no protection was bypassed.
- The prior evaluator was repaired to stop confusing an explanatory Tap example with a current-mode claim. Keyword assertions still do not establish complete factual correctness.
- Formatting checks covered Markdown, explicit Copy, source rendering and narrow layouts in synthetic component fixtures. Content protection prevented native voice screenshots, so native content was inspected through accessibility. These checks did not establish live model answer quality.
- CI passed at the historical documentation closeout `e1f09539f49805df431cadeeba0e4436764747e5`; that is not the current repair's CI status.

Private local captures and rig recovery details belong in the local handover rather than this repository. Existing user data has not been migrated or deleted. Packaged cross-platform behavior, physical offline operation, enterprise accounts, signed-out/quota native behavior and multilingual model-generated help remain separate acceptance requirements. No merge, deployment, release or public documentation publication is established by this report.
