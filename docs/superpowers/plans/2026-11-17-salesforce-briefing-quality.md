# Salesforce briefing quality

**Goal:** Make selected-record briefings reliable after live tests exposed skipped note reads, invented pilot details, and inconsistent citations.

**Architecture:** Retrieve linked notes inside the briefing tool through the existing scoped `get_note` reader. Keep bounded source passages in a per-turn session. A read-only presentation tool selects passages and classifies them; it cannot rewrite evidence or supply CRM values, dates, or URLs. Render CRM facts, gaps, source excerpts and links in code. The chat displays this rendered briefing even if the model skips presentation, with an explicit analysis-unavailable fallback.

**Tech stack:** Existing TypeScript tools, Electron IPC, Markdown chat rendering, Node test runner.

**Spec:** User-approved four steps in this chat; existing two-workflow scope in `docs/superpowers/specs/2026-11-02-salesforce-integration-design.md`.

**Global constraints:** Existing branch; no dependency installs, environment edits, commits or pushes. Preserve note privacy and scope; no CRM writes for briefings. Source data stays transient except excerpts in the visible saved answer. No account/name resolution or automatic record matching.

**Review focus:** Account changes/cancellation, workspace protection, long/truncated notes, concurrent calls and stale selections, multi-provider execution, persistence of private query data, Markdown injection, conflicting passages, mixed requests.

## Task 1: Mandatory bounded retrieval and evidence presentation

- [x] Add failing tests for automatic scoped retrieval, missing/out-of-scope notes, truncation, cancellation, deterministic facts and exact timestamps, validated source selections and proposal status.
- [x] Implement a per-turn briefing session and injected scoped reader. Use full source passages rather than model-rewritten claims to preserve conditions, owners and dates.
- [x] Add a presentation tool with structured findings and conflict references. Validate identifiers against this session; never accept model-supplied links or CRM facts.
- [x] Run Salesforce tool, note-scope and connector-module tests. Expected: all pass.

## Task 2: Render the verified answer in both chat execution paths

- [x] Add regression tests showing model prose cannot overwrite the rendered briefing; cancellation/account changes still fence results; ordinary chat remains unchanged.
- [x] Carry local rendered-answer output separately from model-facing query data. Persist only the visible answer, not raw sources. Keep multiple requested record briefings distinct.
- [x] Run chat engine tests and typecheck. Expected: all pass.

## Task 3: Verification and live acceptance

- [x] Run relevant regression suite, full project tests, lint and format checks; report unrelated failures without silently fixing them.
- [x] Exercise the dev build using UI control: normal linked notes, missing context, contradictory evidence.
- [x] Obtain a fresh review of the changes, address material findings with regression coverage, and update the integration guide with actual results.

## Progress and decisions

- Scope is already approved; implementation continues inline without a new approval gate.
- Existing uncommitted Salesforce/logo changes are retained. No commits or cleanup deletion are part of this task.
- The presentation uses extractive findings: selecting full passages prevents paraphrasing from silently changing 8 proposed pilot reps into 40 committed reps. Status remains an assistant classification; source wording remains visible.

- Task 1/2 verification: 209 focused tests passed, including real Cloud/BYOK chat-engine adapters; typecheck passed. Repository lint: no errors, 10 pre-existing React Refresh warnings.
- Fresh review found and regression-tested heading ancestry/continued conditions and citation collisions across multiple record briefings. Both fixes went RED→GREEN.
- Ruling: keep briefing turns exclusive, with an explicit instruction to ask other questions separately. This prevents unsupported model prose replacing source evidence; combined requests require another message.
- Live payload fix: accept up to 60 selections within the existing bounded source text; normalize explicit proposal/conditional passages to proposed and open questions to unknown. A 27-finding real payload previously exceeded the 24-item limit. Regression went RED→GREEN.
- Live normal case passed at 2026-11-17T12:35:49.743Z: correct CRM null/unavailable labels, exact timestamp, no raw owner ID, cited excerpts, 8-rep pilot and tentative kickoff remain proposed. Screenshot: `/tmp/salesforce-briefing-final-live.png`.
- A screen-capture/session interruption stopped the first full-suite run before a summary. The full project test command was restarted; no success is inferred from partial output.
- Live empty-context case passed at 2026-11-17T12:57:08.770Z on the new synthetic QA Opportunity before any note export: explicit CRM-only fallback, with no inferred meeting findings.
- The synthetic conflicting-decisions note was created and its export review requested. Native UI verification is currently blocked by the locked Mac; no conflicting-evidence acceptance is claimed yet.
- Full-suite result: 15,328 tests; 13,887 passed, 290 failed, one cancelled, 1,149 skipped and one todo. The sandbox denied localhost listeners (`EPERM`); four stalled workers were stopped. Other failures include the shared SQLite binary targeting Electron rather than Node, plus assertions outside this change. This is not a green full-suite result, and unrelated code was not changed to hide failures.
- Authentication/callback retest with localhost access: 135/135 passed, covering Salesforce API/authentication, connector management, relay and OAuth loopback handling, and field approval validation. Together with the 209 focused tests, 344 relevant checks passed. Formatting and `git diff --check` passed.
- Retesting the four stalled files with localhost access produced 154 passes, one failure and two cancellations. Account-scope checks hit sign-out (10-second) and activation-upload (120-second) timeouts, plus a mock of an undefined policy method; the remaining worker was stopped. Enterprise transport, local-model download and streaming-start checks completed. These unrelated account-scope failures remain unresolved.
- After the Mac was unlocked, the expired activity review was renewed and approved for the synthetic QA fixture. Salesforce confirmed the completed Task and intended Opportunity relationship. Screenshot: `/tmp/salesforce-qa-activity.png`.
- Live conflicting-evidence payload revealed that the provider unwrapped a single conflict object instead of returning an array. A RED→GREEN regression now covers normalization of that container, while fabricated IDs, duplicate IDs and model-supplied conclusions remain rejected. The 34 affected tool tests and typecheck passed after this change; this adds one distinct test to the previously passing 344 focused checks.
- Live conflicting-evidence briefing passed at 2026-11-17T13:15:17.174Z: both incompatible pilot decisions have citations, the conflict is explicitly unresolved, and the open question stays unknown. All three planned live cases have now been exercised successfully; the full repository suite remains non-green as recorded above.
