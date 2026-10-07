# Product help in Chat and Voice Assistant

Product questions use the selected model and the existing conversation flow. When tools are available, the model can retrieve official documentation with `search_openwhispr_help` and `read_openwhispr_help`, and inspect a bounded set of current settings with `get_openwhispr_context`. Tool instructions request an answer in the user's language, fresh settings when needed, sources, and honest uncertainty. There is no keyword classifier or app-written answer that intercepts an ordinary conversation.

Help requires a working inference model. If a model is unavailable or does not support tools, the user can open the public documentation directly. Bundled English guidance is reference material for the model when current documentation cannot be fetched; it does not bypass inference, subscription, or model-policy gates. There is no separate Help Center or Support menu entry.

Chat and Voice Assistant render validated official source links and lookup status. Tool names, source labels and privacy/failure explanations are translated in all app locales. Explicit Copy includes readable answer text and source links. Evidence sits outside the Voice Assistant's selectable answer area. Historical settings cards start collapsed and format shortcuts and known settings values for the user.

## Evidence and privacy boundaries

The Electron main process owns the fixed `https://docs.openwhispr.com/mcp` adapter. It requests only curated public article paths, never user questions, settings, history, notes, arbitrary commands or account credentials. Canonical path checks reject external, traversal and cross-topic paths. Requests reject redirects and attach no account cookies. Failed, empty, oversized or truncated responses fall back to bundled reference material.

Transport is bounded to 128 KiB per response, 12,000 characters per article and 24,000 total per lookup, a 12-second lookup deadline, four concurrent requests per renderer and twelve lookups per minute per app process. Model tools additionally limit reference text to 4,000 characters and lookup calls to three per turn. Malformed model-selected paths get at most one recovery lookup per turn, then bundled reference material. Retrieved prose is untrusted reference content, never authority to invoke tools or change settings.

Online documentation lookup respects privacy settings and resolved workspace policy. Privacy restrictions, policy restrictions, lookup limits and unavailable services have separate fallback reasons. A retrieved source does not certify every claim in a model answer; native model-generated help still needs semantic acceptance testing.

The context tool excludes credentials, private endpoints, custom model/deployment names, microphone device labels, paths, notes, dictionaries, calendar contents and account identifiers. The selected model receives relevant current settings for that turn. Help tools do not persist full retrieved articles or settings snapshots in tool metadata: only compact citations, lookup status and read timestamps remain. Historical saved settings are not migrated or deleted; the evidence UI adapts legacy labels to stable field keys and omits device names and the always-unknown OS version. The answer itself remains part of normal saved conversation history and may describe the relevant setting.

All three tools are read-only. Invoking them does not change the normal automatic external caret/clipboard delivery behavior. Ordinary chat, note actions and other model tools retain their existing behavior. Product help is not a separate private chat mode.

## Verification

See [the dated QA record](product-help-qa-2026-10-07.md) and [evaluation instructions](../test/help/README.md). Earlier native matrices tested deterministic app-written guidance with model inference bypassed; those are historical evidence, not acceptance of the current model/tool architecture. Current automated checks cover bounded transport, projection, metadata, cancellation, rendering and ordinary-chat preservation. Live model-generated help quality, physical clipboard behavior, packaged cross-platform operation, enterprise accounts and multilingual native acceptance require fresh verification.
