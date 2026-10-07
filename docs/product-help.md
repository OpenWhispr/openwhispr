# Product help in existing Chat

Recognized English product-help questions in the existing Chat/assistant surface are answered from eight reviewed, versioned, built-in guidance blocks. The app refreshes relevant settings on every turn and renders those facts and validated source links itself. It does not ask the selected model to invent or paraphrase the answer. The separately added Support Help browser/settings panel has been removed.

This path works without an account, subscription, remaining transcription allowance or usable inference model. UI labels and uncertainty/fallback messages use all eleven app locales; the guidance itself is labeled English. Hold/Tap, app version, platform and unknown OS version are distinct facts. A permission or processing selection is not proof that a device works or that the whole app is offline.

Routing uses explicit English intent rules. Supported help topics include shortcuts, microphone, models, meetings, calendars, languages, backup and assistant settings. Known unsupported control requests abstain; mixed help/actions ask for separate requests. Ordinary text transformations and calendar-data requests retain normal chat. This is finite routing coverage, not a guarantee for every language or paraphrase. Requests with an explicit note-action `requestText` retain their existing action flow.

## Evidence and privacy boundaries

The Electron main process owns the fixed `https://docs.openwhispr.com/mcp` adapter. It fetches complete curated topic pages using internally constructed `cat <allowed-path>.mdx` requests. Neither user questions, settings, history, notes nor arbitrary commands leave through this adapter. Reads reject noncanonical, external, traversal and cross-topic paths. A malformed model-tool path gets at most one fixed-topic recovery request per turn, then bundled guidance. Redirects fail closed; no account credential or session cookie is attached.

Transport is bounded to 128 KiB per response, 64,000 characters per complete article, a 12-second lookup deadline, four concurrent requests per renderer and twelve lookups per minute per app process. Empty, failed or explicitly truncated articles fall back. The renderer also bounds context and evidence waits and cancels superseded turns.

Online lookup resolves workspace policy first. Signed-out public lookup is allowed; unresolved policy, minimum-version restrictions, disabled web search or policies without OpenWhispr/BYOK processing use bundled help. Read-only built-in help performs no inference and does not bypass policy gates on ordinary AI requests.

Source labels distinguish an article retrieved now from bundled fallback, including unavailable, rate-limited and policy outcomes. Retrieval does **not** revise or certify the built-in answer. The live Chat article still contains older behavior; unmerged docs PR #44 is not treated as published evidence. Retrieved prose is never executed or synthesized into the guarded answer.

Settings projection excludes credentials, private provider endpoints, custom model/deployment names, paths, notes, dictionaries, calendar events and account identifiers. Guarded help does not send its settings snapshot to an inference provider or run private-note retrieval. The existing conversation still persists the answer and metadata; subsequent ordinary AI turns keep their existing history and tool behavior. This is not a separate private chat mode.

Three read-only help/context tools remain available to ordinary assistant turns. Their data becomes context for that turn's selected model. They hold external caret delivery and preserve the clipboard; the guarded path does the same before any asynchronous lookup.

## Verification

See [the October 7 repair evidence](product-help-qa-2026-10-07.md) and [executable evaluation instructions](../test/help/README.md). The twelve supplied case specifications now run as 36 paraphrases repeated twice (72 synthetic app-boundary turns), plus cancellation, ordinary-chat preservation and independent-review regressions. The capture evaluator separates coverage, abstention, known unsupported claims, sources, freshness, observed side effects and transport. Regex checks and finite passing examples do not establish universal factual accuracy.

Desktop native macOS acceptance and separate Cloud/Groq/Qwen generation smoke checks were performed. Packaged macOS/Windows/Linux, physical network-off, mobile, actual enterprise accounts, signed-out/quota native acceptance and comprehensive multilingual routing remain unverified. No merge, deployment or public docs publication is part of this change.
