# OpenWhispr (fork) - Session Index

Loaded in place of the root `CLAUDE.md`, which `.claude/settings.json` excludes through `claudeMdExcludes`.
The root `CLAUDE.md` belongs to upstream (`OpenWhispr/openwhispr`). It is about 124 KB and changes in almost every upstream PR, so this fork never edits it, which keeps upstream syncs free of conflicts.
**It is still the full technical reference.** Before touching a subsystem, grep it for that subsystem's heading and read only that section, e.g. `Select-String -Path CLAUDE.md -Pattern '^### 17\.'`. Headings are listed below. Use the heading text, never line numbers, because upstream moves things around.

## Response Style

Keep responses focused and brief. Keep caveats short. Explain things at a high level unless asked for depth.

## Project

Electron 43 desktop dictation app with context isolation.
- Renderer: React 19, TypeScript, Tailwind v4, Vite, shadcn/ui on Radix.
- Main process: better-sqlite3.
- Speech-to-text: whisper.cpp, NVIDIA Parakeet/Cohere through sherpa-onnx, and cloud providers.
- Local LLM: llama.cpp.
- Semantic search: Qdrant sidecar plus MiniLM over ONNX.

Two windows share one React codebase with URL routing: the dictation overlay (pill) and the control panel.
All `onnxruntime-node` inference runs in a lazily spawned utility process (`src/helpers/onnxWorkerClient.js` -> `src/workers/onnxWorker.js`).

## Commands

```bash
npm run dev          # Vite renderer + Electron main (predev downloads sidecars/binaries)
npm test             # node --test over test/**/*.test.js (tsx loader)
npm run typecheck    # tsc in src/
npm run lint         # eslint root + src
npm run format:check # eslint + prettier check
npm run i18n:check   # all locale files have every key
npm run pack         # unsigned local package (CSC_IDENTITY_AUTO_DISCOVERY=false)
```

Run a single test with `node --import tsx --test test/helpers/<name>.test.js`.

## Hard rules (break these and CI or release fails)

- **Node 24 only for `npm install`.** Use `nvm exec 24 npm install` if your Node differs. Another major version produces a lockfile that breaks `npm ci`.
- **i18n is required.** Never hardcode UI text.
  - Put every key in `src/locales/{en,es,fr,de,pt,it,ru,zh-CN,zh-TW}/translation.json` and use `useTranslation()`.
  - Do not translate brand names, technical terms, format names, or the shared assistant `fullPrompt`.
  - Changing a default prompt means updating `CURRENT_DEFAULT_PROMPT_HASHES` in `src/config/retiredPrompts.js`.
- **Icons:**
  - Use `src/components/icons/` only. Never import `lucide-react`.
  - Add an icon through `nucleo-map.json`, then run `node scripts/sync-nucleo-icons.js`. Hand-drawn icons go in `primitives.tsx`.
- **Assets:**
  - Always `import` them. A literal `/assets/...` path breaks under `file://`.
  - Use lossless WebP authored at 2x the slot size, with explicit `width`/`height`.
  - Decorative images get `alt=""` plus `aria-hidden`.
- **New IPC channel:** register it in both `src/helpers/ipcHandlers.js` and `preload.js`.
- **New sidecar binary:**
  - Add a download script, add it to the `prebuild*` scripts, and create a manager in `src/helpers/`.
  - Spawn it with `detached: process.platform !== "win32"` and call `sidecarPidFile.write`/`clear`.
  - Add it to `EXPECTED_BINARY_FRAGMENTS` in `sidecarReaper.js` and call `sidecarRegistry.register` in `registerSidecars()`.
- **Windows signing:** `electron-builder.json` forces signing. Unsigned builds use `electron-builder.unsigned-win.json`. Never ship a `win-unpacked` left behind by a failed signed build.
- **Never change the Windows tray GUID** in `tray.js`.
- **Models:** `src/models/modelRegistryData.json` is the single source of truth for desktop models. Retired models are remapped in `src/config/retiredCloudModels.ts`.
- **Secrets:** the 12 keys in `SECRET_KEYS` (`environment.js`) are encrypted with `safeStorage` and stored under `userData/secure-keys/`. Non-secret preferences go to `.env` through `saveAllKeysToEnvFile()`.

## Pattern to follow

Decision logic lives in pure, Electron-free policy modules with unit tests (`*Policy.js`, `meetingMicGate.js`, `meetingMicHoldback.js`, `meetingSegmentReducer.ts`). IPC handlers are thin adapters over them. New behavior goes in the policy module first, together with a test in `test/`.

## Root CLAUDE.md map (grep the heading, read the section)

| Area | Heading in root `CLAUDE.md` |
|------|-----------------------------|
| Every helper module (clipboard/paste, hotkeys, dock, autostart, calendars, meeting detection, connectors: Gmail/Slack/Linear/GitHub) | `### Helper Modules (src/helpers/)` |
| Native C/Swift helpers | `### Native Resources (resources/)` |
| Components, hooks, services, inference providers/scopes | `### React Components`, `### React Hooks`, `### Services` |
| whisper.cpp / Parakeet / Cohere / streaming commit | `### whisper.cpp Integration`, `### NVIDIA Parakeet Integration` |
| Qdrant + MiniLM lazy lifecycle | `### Local Semantic Search` |
| Download/build scripts | `### Build Scripts (scripts/)` |
| Audio flow, DB schema, settings keys, languages | `### 2.` to `### 6.` |
| Agent naming + provider/model list | `### 7. Agent Naming System`, `### 8. Model Registry Architecture`, `### 9. API Integrations` |
| OS settings URLs, debug logging | `### 10.`, `### 11. Debug Mode` |
| Windows push-to-talk, custom dictionary | `### 12.`, `### 13.` |
| GNOME / Hyprland Wayland hotkeys | `### 14.`, `### 15.` |
| Meeting detection, echo/segment pipeline | `### 16.`, `### 18.` |
| Voice assistant hotkey, screen context, connector tools in chat | `### 17. Voice Assistant Hotkey` |
| Note templates and actions | `### 19. Note Templates and Actions` |
| Testing checklist, common issues, per-platform notes | `### Testing Checklist`, `### Common Issues and Solutions`, `### Platform-Specific Notes` |

## Fork notes

- Remotes: `origin` = `finedesignz/openwhispr`, `upstream` = `OpenWhispr/openwhispr`. Upstream syncs land on `chore/sync-upstream-*` branches.
- STT API planning moved to the `openwhispr-stt-api` repo (PR #12). See `.planning/RELOCATED.md`. The `.planning/` files still here are historical.
- Fork-only files: this index and `.claude/settings.json`. Keep fork changes out of upstream-owned files wherever possible.
