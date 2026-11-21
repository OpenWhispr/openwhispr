# Phase 8: LLM subscription connect - Context

**Gathered:** 2026-11-20
**Status:** Ready for planning
**Research:** `08-RESEARCH.md` (design doc from the team lead's research agent, copied verbatim)

## Phase goal

EdgeAssistant connects to LLM providers through the user's own subscription, with no API keys.
Claude, Codex/OpenAI, Gemini (Google Antigravity, Google-account OAuth) and Grok sign in through each vendor's official CLI, hosted locally by the Electron main process.
This follows the "Zero Exposure" shape in AAF origin/main.
Tokens stay on the user's PC.
There is no hosted broker, and OAuth is never reimplemented.

## Locked decisions

### D-01: Shape = local official CLIs driven by Electron main
- Sign-in:
  - Claude: `claude setup-token`, run in a pty.
  - Codex: `codex login --device-auth`.
  - Grok: `grok login --device-auth`.
  - agy: its browser OAuth.
- Calls:
  - `claude -p`, `codex exec`, `grok -p`, `agy -p`, spawned by main with `windowsHide: true`.
  - Output is streamed back over IPC.
- Any token a CLI hands back to us (e.g. the `setup-token` output) is stored with Electron `safeStorage`, like `SECRET_KEYS`.
  - It is never written to `.env`, logs or the renderer.
  - CLIs that keep their own credential store keep using it.
- Decision logic lives in a pure policy module, `src/helpers/llmCliProviders.js`, with a node test in `test/helpers/`. It covers:
  - provider table
  - detection paths
  - argv builders
  - state machine
  - output parsing
- The IPC handlers are thin adapters, registered in both `src/helpers/ipcHandlers.js` and `preload.js`.
- UI strings go in all locale dirs (en, es, fr, de, pt, it, ru, zh-CN, zh-TW, ar, ja).

### D-02: CLI availability = detect + consent install, never bundle (2-seat panel, 2026-11-20, unanimous)
- **No bundling.** The four native CLIs total about 1.07 GB (claude 370 MB, codex 308 MB, grok 168 MB, agy 225 MB; measured on disk).
  - The claude-code license is proprietary ("SEE LICENSE IN README.md"), so redistribution needs Anthropic's permission.
  - agy's license is unverified.
  - The CLIs self-update, and a pinned copy breaks against server-side version checks.
  - Bundling would also mean Azure-signing vendor binaries.
- **Detect:** look on PATH AND in the known per-user install dirs, because a fresh install is not on the running app's PATH:
  - `%USERPROFILE%\.local\bin\claude.exe`
  - `%USERPROFILE%\.grok\bin\grok.exe`
  - `%LOCALAPPDATA%\agy\bin\agy.exe`
  - the npm global `codex`, or its native `@openai/codex-win32-x64` exe
  Then run `<cli> --version`. Add macOS/Linux equivalents. Provide a "Re-detect" button.
- **Install:**
  - Where the vendor ships an official installer script or binary, the app runs it after explicit user consent, in a hidden shell, and streams progress.
  - Otherwise it shows a guided install: the official link plus the exact command.
  - The planner must verify each installer URL from the vendor's official docs before it is coded. An unverified source gets the guided install only.
  - Do not depend on PowerShell execution policy: call the `.exe`, never a `.ps1` shim.
- Panel-noted failure modes the plan must handle:
  - an installed CLI that is too old for the flags used (version floor per provider)
  - antivirus quarantining a fresh download
  - a CLI that is installed but not logged in

### D-03: Dictation cleanup stays off the CLIs (latency measured 2026-11-20)
Measured on this PC with a typical cleanup prompt (`scratchpad/latency/results.md`):

| CLI | warm ms |
|---|---|
| claude -p (haiku) | ~26000 |
| codex exec | ~25000 |
| agy -p | ~10700 |
| grok -p | hung (no output in 90 s) |

The target is about 1.5 s or less. Dictation cleanup therefore stays on local llama.cpp or EdgeAssistant cloud (stt-api cleanup, Phase 5 D-04). The CLI providers serve chat and agent work only, and the cleanup provider picker does not list them.

### D-04: Claude seat is gated behind a setting (owner-acknowledged risk)
**Risk, owner-acknowledged 2026-11-20 (raised once by the team lead):** Anthropic's Agent SDK terms bar third-party products from offering claude.ai subscription login without Anthropic's approval.
- The Claude seat ships disabled behind a setting, off by default.
- Enabling it shows a one-line notice.
- The Codex, Grok and agy seats are not gated.
- This risk is recorded here, not re-argued.

### D-05: BYOK provider rows stay until this phase lands
The existing BYOK API-key rows stay unchanged while the CLI path is built. The EdgeAssistant cloud STT path already has no key field (E9, PR #30). Whether to remove BYOK LLM rows after this phase is out of scope here.

## Open items for the planner (resolve by checking, not by asking)
- agy: `agy --help` shows no login subcommand. Find its sign-in and headless flow (browser OAuth). If none is scriptable, ship the agy seat as detect+guide with a "sign in by running agy once" step.
- grok `-p` hung in the latency run. The plan must include a timeout, a not-logged-in check, and an output-parse contract per CLI.
- Claude: `setup-token` prints a long-lived token. Capture it from the pty without logging it, and store it in safeStorage. Pass it to `claude -p` through the env var the CLI documents (verify the name) when calling.
- Version floors per CLI for the flags used.

## Canonical refs
- `08-RESEARCH.md`: AAF prior art, the current EdgeAssistant API-key plumbing, risks.
- `.claude/CLAUDE.md`: repo hard rules (IPC in both files, i18n, icons, signing, sidecar conventions).
- `src/helpers/environment.js` `SECRET_KEYS`: the safeStorage pattern.
