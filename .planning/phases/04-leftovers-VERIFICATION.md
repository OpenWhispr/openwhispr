---
phase: tiwh-v1.0 leftovers (phases 1-4: CI-02, AUTH-01 config side, STT-03)
verified: 2026-11-18
status: passed_with_warnings
qc_mode: cross-model (Claude + Codex responded; Grok/agy not run)
prs: [17, 18, 19]
---

# TIWH leftovers verification (PRs #17, #18, #19)

Ship verdict: **SHIP all three** (merge order #17, #19, #18). No content blockers. Warnings listed below.

QC seats: Claude verifier (this report) and Codex (`codex exec --sandbox read-only`, responded with per-PR verdicts; its sandbox could not spawn node, so it read code and ran URL/Buffer probes only). Grok and agy were not run. Minimum of 2 model families met (Claude + Codex).

## PR #17 fix/tiwh-leftovers - QC: PASS (warnings)

| Item | Status | Evidence |
|---|---|---|
| CI-02 mobile CI gated | PASS | `.github/workflows/mobile-ci.yml` lines 22, 28, 48, 105, 129: all five jobs carry `github.repository == 'OpenWhispr/openwhispr'`; `test/config/forkWorkflows.test.js:52` asserts it; `gh pr checks 17`: Mobile CI / lockfile / checks / Swift all "skipping". `forkWorkflows.test.js` + `meetingMicGate.test.js`: 30/30 pass. |
| computeChunkStats odd-offset | PASS | `src/helpers/meetingMicGate.js:19-21` copies via `Buffer.from` when `byteOffset` is odd; new test `meetingMicGate.test.js:211` passes. Codex confirms correct. |
| `* text=auto eol=lf` safe | PASS | `git ls-files --eol`: 3178 text files i/lf w/lf, 0 crlf or mixed in index; 40 files i/-text (20 png, 12 webp, 4 woff2, 2 mp4, ico, icns) untouched; no .exe/.dll/.onnx tracked. `text=auto` keeps content-detected binaries as is, so no renormalization diff. NSIS `.nsh` is LF-safe. |
| Phase 1 SC3 ("Windows workflow passes on a PR with the full suite") | PARTIAL | `gh pr checks 17`: build-windows pass (windows-latest, installer build + fork smoke), quality pass (17m31s). But the full test suite ("Run tests") runs in `quality` on **ubuntu-latest**; the Windows job runs no tests. SC3 holds only if "workflow" = Desktop CI as a whole. Pre-existing (Phase 1, PR #10), not introduced by #17. |

Findings:
1. WARNING `.gitattributes:1-2`: the PR REPLACES upstream's `openwhispr-mobile/patches/*.patch -whitespace` instead of appending. Drops a whitespace exemption for patch-package patches (harmless to patch-package; affects `git diff --check`) and creates a needless upstream-sync conflict line. Fix: keep the old line, add the new one. Codex agrees.
2. WARNING (claim accuracy): the PR claims the .gitattributes fix cures local Windows-only failures. Local `npm test` on Windows in this worktree (Node 24.19.0): 8900 tests, 8831 pass, **20 fail**, 48 skipped. All 20 are Windows platform issues, none CRLF: AF_UNIX listen EACCES (cosmicToplevel), EPERM temp rmSync (granola/meeting/orukeet/provider/streaming/whisper IPC), apostrophe path (extractArchive), Linux sysfs (linuxKeyManager), timezone (calendarDatabase), tar/kill, and others. Because CI runs tests on Linux only, these never surface in CI. Not caused by or fixable by #17; recommend a follow-up ticket to skip-by-platform or fix, or to add a Windows test job.
3. INFO: optional hardening `*.exe -text`, `*.dll -text`, `*.onnx -text`, `*.node -text` for explicit binary safety.

## PR #18 feat/tiwh-auth01 - QC: PASS (config side), provisioning readback UNVERIFIED

| Item | Status | Evidence |
|---|---|---|
| `TITANIUM.keygenProductId` set | PASS | `src/config/fork.config.json:26` = `bbe843ac-4de5-486c-85e2-1a1b7e533e5f`; JSON parses; consumed at `src/helpers/titanium/titaniumSession.js:171`; CI quality + build-windows pass. appSlug/portalUrl unchanged. |
| Product exists in Keygen and bound to `titanium-whisper`, `titaniumwhisper://auth` allowed | UNCERTAIN | Only evidence is `.planning/STATE.md:34` and `REQUIREMENTS.md:82` (self-reported "proven by API 200 vs 400"). I could not read back independently: portal `/api/apps/*` is an SPA catch-all, no Keygen credential found in Pass under `keygen`/`titanium-licensing`, Coolify list not usable. Codex raised this as a BLOCKER for lack of evidence; I rate it WARNING (a one-line config value; a wrong id fails loudly at sign-in, and end-to-end sign-in round trip is already listed as not yet run). Action: run the Phase 3 sign-in round trip after merge to close AUTH-01.
| Local tests | SKIPPED | auth01 worktree has no node_modules (env, not PR defect); relied on CI.

## PR #19 feat/tiwh-stt03-stable-domain - QC: PASS

| Item | Status | Evidence |
|---|---|---|
| Default URL stable domain | PASS | `fork.config.json` DEFAULT_STT.baseUrl = `https://stt.titaniumlabs.us/v1`; flows via `forkDefaults.ts:12`; `git grep` finds old host only in the migration constant and a planning doc. |
| Live | PASS | `GET https://stt.titaniumlabs.us/healthz` 200 (engine parakeet, warm); old host `x1gsjcjrmssitgnh7hthg7nd.coolify.titaniumlabs.us/healthz` 200 (kept, so unmigrated installs still work). |
| Saved-URL migration | PASS | `src/config/forkSttMigration.ts`: exact parsed-hostname match (rejects `legacy.evil.example` and `legacy@evil.example`), preserves path, port, query, userinfo; idempotent; 6 keys all read by `settingsStore.ts` (Codex: lines 1569-1829). Hook `settingsStore.ts:~901-912` runs before store creation, guarded by `isBrowser`, `!CLOUD_ENABLED`. `forkSttMigration.test.js`: 4/4 pass. |
| CI | PENDING at time of check | `gh pr checks 19`: quality + CodeQL desktop pending (all others pass). Re-check before merge. |

Findings:
1. WARNING `forkSttMigration.ts:48` `storage.setItem` can throw (quota) at module init; `getItem/setItem` not try/caught. Edge, consistent with other migrations in the file. No store-level integration test.
2. INFO: no test for a userinfo/port URL (Codex probed manually: preserved correctly).

## Ship order and follow-ups
1. Merge #17 (optionally amend `.gitattributes` to keep the `-whitespace` line), #19 once CI green, #18.
2. Follow-ups: ticket the 20 Windows-only local test failures; run the AUTH-01 sign-in round trip against the live portal.
