# Gemma Download Prompt + Simplified Model Settings

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** On first launch, prompt the user to download Gemma 4 E4B (~5.4 GB) for offline meeting notes generation. If they accept, download with progress banner. If they decline, skip — they can configure a remote endpoint later. Simplify ALL model settings pages across the app from a 5-tab interface (OpenWhispr Cloud / Providers / Local / Self-Hosted / Enterprise) to just 2 options: built-in Gemma or remote OpenAI/Anthropic-compatible API endpoint.

**Architecture:** A one-time prompt modal appears after onboarding completes (or on the first ControlPanel mount after the Parakeet download finishes). The user's choice is persisted to localStorage so the prompt never shows again. If they accept, the Gemma download uses the existing auto-download banner infrastructure. On download completion, noteFormatting is auto-configured to `{ provider: "local", model: "gemma-4-e4b-it-q4_k_m" }`. The `InferenceConfigEditor` component is simplified from 5 mode tabs to 2 options (built-in / remote) across all 4 inference scopes.

**Tech Stack:** Electron IPC, Zustand, React, i18next, existing `modelManagerBridge.downloadModel()`, existing `modelAutoDownloadStore`.

---

## Structural Facts (verified against the real code)

1. **Gemma 4 E4B** is already in `modelRegistryData.json` (line 995-1006) as `"gemma-4-e4b-it-q4_k_m"`, 5.4 GB, `recommended: true`. Provider: `"gemma"`. Download URL: `https://huggingface.co/bartowski/google_gemma-4-E4B-it-GGUF/resolve/main/google_gemma-4-E4B-it-Q4_K_M.gguf`.

2. **`modelManagerBridge.js`** handles LLM downloads. `downloadModel(modelId, onProgress)` (line 170) — `onProgress` receives **three** positional args: `(progress, downloadedBytes, totalBytes)` where `progress` is a percentage 0-100. `isModelDownloaded(modelId)` (line 133) is **async**, returns boolean. `cancelDownload(modelId)` (line 266) aborts via `AbortController`. The method returns the model file path (a string) on success, NOT `{ success: boolean }`. Access the manager via lazy require: `const modelManager = require("./modelManagerBridge").default` — there is NO `this.modelManager` on the IPC handlers class.

3. **LLM download IPC:** `model-download` (invoke), `model-download-progress` (event: `{ modelId, progress, downloadedSize, totalSize }`), `model-cancel-download` (invoke with `modelId`).

4. **`InferenceConfigEditor`** (src/components/settings/InferenceConfigEditor.tsx) is used 4 times across settings:
   - `scope="noteFormatting"` — SettingsPage.tsx:415
   - `scope="dictationCleanup"` — SettingsPage.tsx:448
   - `scope="dictationAgent"` — DictationAgentSettings.tsx:140
   - `scope="chatIntelligence"` — ChatAgentSettings.tsx:13

   It renders a 5-tab `InferenceModeSelector` with modes: `openwhispr`, `providers`, `local`, `self-hosted`, `enterprise`. All 5 tabs are non-functional in this fork except `local` and `self-hosted`.

5. **`InferenceMode`** type: `"openwhispr" | "providers" | "local" | "self-hosted" | "enterprise"` (src/types/electron.ts). After simplification, only `"local"` and `"self-hosted"` are used.

6. **Existing auto-download channels:** `parakeet-auto-download-status` and `parakeet-auto-download-progress` — used by `modelAutoDownloadStore.ts` and `ModelDownloadBanner.tsx`. These will be renamed to `model-auto-download-*` to serve both Parakeet and Gemma.

7. **`_ensureNoteFormattingConfigured` pattern:** When Gemma downloads, set `process.env.NOTE_FORMATTING_PROVIDER = "local"` and `process.env.NOTE_FORMATTING_MODEL = "gemma-4-e4b-it-q4_k_m"` — only if not already set by the user.

8. **`OpenAICompatiblePanel`** (src/components/OpenAICompatiblePanel.tsx) already exists — renders base URL + API key + model name fields. This is the "remote endpoint" option. Used in `InferenceConfigEditor` when `mode === "self-hosted"`.

---

## Feature Area 1: Rename Auto-Download Channels to Generic

### Task 1.1: Rename IPC channels from parakeet-specific to generic

**Files:**
- Modify: `src/helpers/ipcHandlers.js` — rename channel strings in `_autoDownloadParakeetModel()` and status handler
- Modify: `preload.js` — rename listener registrations
- Modify: `src/types/electron.ts` — rename type signatures
- Modify: `src/stores/modelAutoDownloadStore.ts` — update listener subscriptions

**Step 1: In `ipcHandlers.js`**, find-and-replace in `_autoDownloadParakeetModel()`:
- `"parakeet-auto-download-status"` → `"model-auto-download-status"` (all occurrences)
- `"parakeet-auto-download-progress"` → `"model-auto-download-progress"` (all occurrences)

And rename the IPC handler:
- `"get-parakeet-auto-download-status"` → `"get-model-auto-download-status"`

Update the handler body to also report Gemma state (will be wired in Task 2.1).

**Step 2: In `preload.js`**, rename the three entries (near line 292):
```js
// Before:
onParakeetAutoDownloadStatus: registerListener("parakeet-auto-download-status"),
onParakeetAutoDownloadProgress: registerListener("parakeet-auto-download-progress"),
getParakeetAutoDownloadStatus: () => ipcRenderer.invoke("get-parakeet-auto-download-status"),

// After:
onModelAutoDownloadStatus: registerListener("model-auto-download-status"),
onModelAutoDownloadProgress: registerListener("model-auto-download-progress"),
getModelAutoDownloadStatus: () => ipcRenderer.invoke("get-model-auto-download-status"),
```

**Step 3: In `src/types/electron.ts`**, rename the type signatures to match the new names.

**Step 4: In `modelAutoDownloadStore.ts`**, update all references:
- `onParakeetAutoDownloadStatus` → `onModelAutoDownloadStatus`
- `onParakeetAutoDownloadProgress` → `onModelAutoDownloadProgress`
- `getParakeetAutoDownloadStatus` → `getModelAutoDownloadStatus`

**Step 5: Commit**
```bash
git commit -m "refactor: rename auto-download IPC channels from parakeet-specific to generic"
```

---

## Feature Area 2: Gemma Download with One-Time Prompt

### Task 2.1: Add `_downloadGemmaModel()` method to ipcHandlers

**Files:**
- Modify: `src/helpers/ipcHandlers.js` — add method, instance state, IPC handler

**Step 1: Add instance state** (near existing `_parakeetAutoDownloadActive`):
```js
this._gemmaAutoDownloadActive = false;
```

**Step 2: Add the download method** (after `_autoDownloadParakeetModel()`). Unlike Parakeet, this is NOT called automatically at startup — it's triggered by the renderer after the user accepts the prompt:

```js
/**
 * Download the built-in Gemma local LLM for offline note generation.
 * Triggered by the renderer after the user accepts the one-time prompt.
 * Uses the generic model-auto-download channels for progress/status.
 */
async _downloadGemmaModel() {
  if (this._gemmaAutoDownloadActive) return;

  const defaultModel = "gemma-4-e4b-it-q4_k_m";
  const modelName = "Gemma 4 E4B";
  const sizeMb = 5812; // actual sizeBytes / 1_000_000

  const modelManager = require("./modelManagerBridge").default;
  const isDownloaded = await modelManager.isModelDownloaded(defaultModel);
  if (isDownloaded) {
    this.broadcastToWindows("model-auto-download-status", {
      type: "not-needed",
      modelId: defaultModel,
    });
    this._ensureNoteFormattingConfigured(defaultModel);
    return;
  }

  this._gemmaAutoDownloadActive = true;
  this.broadcastToWindows("model-auto-download-status", {
    type: "started",
    modelId: defaultModel,
    modelName,
    sizeMb,
  });

  debugLogger.info("Downloading Gemma model for offline note generation",
    { model: defaultModel }, "startup");

  try {
    const result = await modelManager.downloadModel(defaultModel, (progress, downloadedBytes, totalBytes) => {
      this.broadcastToWindows("model-auto-download-progress", {
        type: "progress",
        percentage: Math.round(progress),
        downloaded_bytes: downloadedBytes,
        total_bytes: totalBytes,
      });
    });
    this._gemmaAutoDownloadActive = false;
    if (result) { // downloadModel returns modelPath string on success, not { success }
      debugLogger.info("Gemma download complete", { model: defaultModel }, "startup");
      this.broadcastToWindows("model-auto-download-status", {
        type: "complete",
        modelId: defaultModel,
      });
      this._ensureNoteFormattingConfigured(defaultModel);
    }
  } catch (err) {
    this._gemmaAutoDownloadActive = false;
    if (err.message?.includes("aborted") || err.code === "DOWNLOAD_CANCELLED") {
      debugLogger.info("Gemma download cancelled by user", {}, "startup");
      this.broadcastToWindows("model-auto-download-status", {
        type: "cancelled",
        modelId: defaultModel,
      });
    } else {
      debugLogger.warn("Gemma download failed", { error: err.message }, "startup");
      this.broadcastToWindows("model-auto-download-status", {
        type: "error",
        modelId: defaultModel,
        error: err.message,
      });
    }
  }
}

/**
 * Auto-configure noteFormatting to use the built-in Gemma model if no
 * provider is currently set. Does not override user's existing choice.
 */
_ensureNoteFormattingConfigured(modelId) {
  const currentProvider = process.env.NOTE_FORMATTING_PROVIDER;
  const currentModel = process.env.NOTE_FORMATTING_MODEL;
  if (currentProvider && currentModel) return;

  process.env.NOTE_FORMATTING_PROVIDER = "local";
  process.env.NOTE_FORMATTING_MODEL = modelId;
  this.environmentManager.saveAllKeysToEnvFile().catch(() => {});
  debugLogger.info("Auto-configured noteFormatting to local Gemma",
    { provider: "local", model: modelId }, "startup");
}
```

**Step 3: Add IPC handler** to trigger the download from the renderer:
```js
ipcMain.handle("download-gemma-builtin", async () => {
  this._downloadGemmaModel();
  return { success: true };
});
```

**Step 4: Add to preload.js:**
```js
downloadGemmaBuiltin: () => ipcRenderer.invoke("download-gemma-builtin"),
```

**Step 5: Add type to electron.ts:**
```ts
downloadGemmaBuiltin?: () => Promise<{ success: boolean }>;
```

**Step 6: Update `get-model-auto-download-status`** to report Gemma state:
```js
ipcMain.handle("get-model-auto-download-status", async () => {
  if (this._parakeetAutoDownloadActive) {
    return { active: true, modelId: "parakeet-tdt-0.6b-v3" };
  }
  if (this._gemmaAutoDownloadActive) {
    return { active: true, modelId: "gemma-4-e4b-it-q4_k_m" };
  }
  return { active: false, modelId: null };
});
```

**Step 7: Add concurrent download guard** in the existing `model-download` handler:
```js
if (this._gemmaAutoDownloadActive && modelId === "gemma-4-e4b-it-q4_k_m") {
  return { success: false, error: "Download already in progress." };
}
```

**Step 8: Commit**
```bash
git commit -m "feat: add Gemma download method with noteFormatting auto-config"
```

---

### Task 2.2: Create GemmaDownloadPrompt component

**Files:**
- Create: `src/components/GemmaDownloadPrompt.tsx`

**Step 1: Create a modal prompt** that appears once and asks the user to download Gemma:

```tsx
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Cpu, X } from "lucide-react";
import { Button } from "./ui/button";

const GEMMA_PROMPT_KEY = "gemmaDownloadPromptDismissed";

export default function GemmaDownloadPrompt() {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const [isGemmaDownloaded, setIsGemmaDownloaded] = useState(false);

  useEffect(() => {
    // Don't show if already dismissed or Gemma already downloaded
    if (localStorage.getItem(GEMMA_PROMPT_KEY) === "true") return;

    window.electronAPI?.modelCheck?.("gemma-4-e4b-it-q4_k_m").then((downloaded) => {
      if (downloaded) {
        localStorage.setItem(GEMMA_PROMPT_KEY, "true");
        setIsGemmaDownloaded(true);
      } else {
        setShow(true);
      }
    });
  }, []);

  const handleAccept = () => {
    localStorage.setItem(GEMMA_PROMPT_KEY, "true");
    setShow(false);
    window.electronAPI?.downloadGemmaBuiltin?.();
  };

  const handleDecline = () => {
    localStorage.setItem(GEMMA_PROMPT_KEY, "true");
    setShow(false);
  };

  if (!show || isGemmaDownloaded) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-xl shadow-lg max-w-md w-full mx-4 p-6">
        <div className="flex items-start gap-4">
          <div className="shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Cpu size={20} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground mb-1">
              {t("gemmaPrompt.title")}
            </h3>
            <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
              {t("gemmaPrompt.description")}
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={handleAccept} className="text-xs">
                {t("gemmaPrompt.accept")}
              </Button>
              <Button size="sm" variant="ghost" onClick={handleDecline} className="text-xs text-muted-foreground">
                {t("gemmaPrompt.decline")}
              </Button>
            </div>
          </div>
          <button
            onClick={handleDecline}
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**
```bash
git commit -m "feat: add GemmaDownloadPrompt one-time modal component"
```

---

### Task 2.3: Wire prompt into ControlPanel and update cancel routing

**Files:**
- Modify: `src/components/ControlPanel.tsx` — render `GemmaDownloadPrompt`
- Modify: `src/stores/modelAutoDownloadStore.ts` — update cancel routing

**Step 1: In ControlPanel.tsx**, import and render the prompt:
```tsx
import GemmaDownloadPrompt from "./GemmaDownloadPrompt";
```

Render inside the component (near the bottom, after existing modals):
```tsx
<GemmaDownloadPrompt />
```

**Step 2: In `modelAutoDownloadStore.ts`**, update `cancelAutoDownload` to route based on model type:
```ts
export async function cancelAutoDownload(): Promise<void> {
  const { modelId } = useModelAutoDownloadStore.getState();
  if (modelId === "parakeet-tdt-0.6b-v3") {
    await window.electronAPI?.cancelParakeetDownload?.();
  } else if (modelId) {
    await window.electronAPI?.modelCancelDownload?.(modelId);
  }
}
```

**Step 3: Commit**
```bash
git commit -m "feat: wire GemmaDownloadPrompt into ControlPanel with cancel routing"
```

---

### Task 2.4: Update i18n — generic banner text + Gemma prompt strings

**Files:**
- Modify: `src/locales/en/translation.json` — update `controlPanel.modelDownload.description` + add `gemmaPrompt` keys
- Modify: all other 9 locale files
- Modify: `src/components/ModelDownloadBanner.tsx` — use interpolation

**Step 1:** In `ModelDownloadBanner.tsx`, update the description line to use interpolation:
```tsx
{t("controlPanel.modelDownload.description", {
  modelName: modelName || "model",
  sizeMb: sizeMb ? Math.round(sizeMb / 1000 * 10) / 10 : "unknown",
})}
```

**Step 2:** In `src/locales/en/translation.json`, update:
```json
"modelDownload": {
  "description": "To run completely offline, OpenWhispr is downloading {{modelName}} (~{{sizeMb}} GB). Please leave the app open while it downloads.",
  ...
}
```

And add under a new `gemmaPrompt` key:
```json
"gemmaPrompt": {
  "title": "Download Gemma 4 E4B for meeting notes?",
  "description": "OpenWhispr uses Gemma 4 E4B (~5.4 GB) as a fully local AI model to auto-generate meeting titles, detect meeting types, and create structured meeting notes. Without it, these features won't be available. You can also connect your own remote API endpoint instead.",
  "accept": "Download Gemma (5.4 GB)",
  "decline": "Not now"
}
```

**Step 3:** Add equivalent keys to the other 9 locales.

**Step 4: Commit**
```bash
git commit -m "feat: add Gemma prompt i18n keys and generic banner interpolation"
```

---

## Feature Area 3: Simplified Model Settings (All Scopes)

### Task 3.1: Simplify InferenceConfigEditor to 2 options

**Files:**
- Modify: `src/components/settings/InferenceConfigEditor.tsx` — replace 5 tabs with 2 options

**Step 1:** Replace the `modes` array (lines 67-100) with just 2 options:

```tsx
const modes: InferenceModeOption[] = [
  {
    id: "local",
    label: t(`${prefix}.local`),
    description: t(`${prefix}.localDesc`),
    icon: <Cpu className="w-4 h-4" />,
  },
  {
    id: "self-hosted",
    label: t(`${prefix}.selfHosted`),
    description: t(`${prefix}.selfHostedDesc`),
    icon: <Network className="w-4 h-4" />,
  },
];
```

Remove the imports for `Cloud`, `Key`, `Building2` from lucide-react (only `Cpu` and `Network` needed).

**Step 2:** Remove the `openwhispr` mode handling in `handleModeSelect` (lines 112-115):
```tsx
// Remove this block:
// if (mode === "openwhispr" && !isSignedIn) {
//   startCloudOnboarding();
//   return;
// }
```

**Step 3:** Remove the `isSignedIn` dependency and `startCloudOnboarding` function.

**Step 4:** Remove the `config.mode === "providers"` render branch (line 168) and `config.mode === "enterprise"` render branch (lines 200-207).

**Step 5:** For the `local` mode, instead of showing the full `ReasoningModelSelector` with provider tabs and model lists, show a simple "Built-in Gemma 4 E4B" card with download status:

```tsx
{config.mode === "local" && (
  <GemmaModelCard
    isDownloaded={/* check model status */}
    onDownload={() => window.electronAPI?.downloadGemmaBuiltin?.()}
  />
)}
```

Create a small inline component or extract `GemmaModelCard` that shows:
- Model name + size
- Download status (downloaded / downloading / not downloaded)
- Download button if not downloaded

**Step 6: Commit**
```bash
git commit -m "feat: simplify InferenceConfigEditor to local + remote options only"
```

---

### Task 3.2: Update i18n mode labels for simplified UI

**Files:**
- Modify: `src/locales/en/translation.json` — update mode labels
- Modify: all other 9 locale files

**Step 1:** Update the mode labels (under `settingsPage.aiModels.modes` and `dictationAgent.modes` and `agentMode.settings.modes`):

```json
"local": "Built-in Model",
"localDesc": "Gemma 4 E4B — runs fully offline on your device",
"selfHosted": "Remote API",
"selfHostedDesc": "Connect to any OpenAI or Anthropic-compatible endpoint"
```

**Step 2:** Add to all 9 other locales.

**Step 3: Commit**
```bash
git commit -m "feat: update mode labels for simplified 2-option settings UI"
```

---

### Task 3.3: Auto-configure noteFormatting on ControlPanel startup

**Files:**
- Modify: `src/components/ControlPanel.tsx` — update the sync useEffect

**Step 1:** Update the existing sync useEffect to auto-configure Gemma if no provider is resolved and Gemma is downloaded:

```tsx
useEffect(() => {
  const state = useSettingsStore.getState();
  const resolved = selectResolvedNoteFormatting(state);

  if (!resolved.provider) {
    // No LLM configured — check if Gemma is downloaded and auto-configure
    window.electronAPI?.modelCheck?.("gemma-4-e4b-it-q4_k_m").then((downloaded) => {
      if (downloaded) {
        useSettingsStore.getState().setNoteFormattingMode("local");
        useSettingsStore.getState().setNoteFormattingProvider("local");
        useSettingsStore.getState().setNoteFormattingModel("gemma-4-e4b-it-q4_k_m");
        window.electronAPI?.syncNoteFormattingConfig?.({
          provider: "local",
          model: "gemma-4-e4b-it-q4_k_m",
        });
      }
    });
    return;
  }

  window.electronAPI?.syncNoteFormattingConfig?.({
    provider: resolved.provider,
    model: resolved.model,
  });
}, []);
```

**Step 2: Commit**
```bash
git commit -m "feat: auto-configure noteFormatting to Gemma on startup when available"
```

---

## Execution Order and Dependencies

```
Task 1.1 (rename channels)           ── do first, all else depends on it
Task 2.1 (Gemma download method)     ── depends on 1.1
Task 2.2 (prompt component)          ── independent (new file)
Task 2.3 (wire prompt + cancel)      ── depends on 1.1, 2.1, 2.2
Task 2.4 (i18n + banner interp)      ── depends on 1.1
Task 3.1 (simplify editor)           ── independent
Task 3.2 (i18n mode labels)          ── independent
Task 3.3 (auto-configure startup)    ── depends on 2.1
```

Recommended batches:
1. **Batch A** (foundations): Tasks 1.1, 2.2, 3.1, 3.2
2. **Batch B** (wiring): Tasks 2.1, 2.4
3. **Batch C** (integration): Tasks 2.3, 3.3

---

## Critical Warnings

1. **5.4 GB download — prompted, not automatic.** The user must explicitly accept. The choice is persisted to `localStorage("gemmaDownloadPromptDismissed")`. The prompt only appears once — dismissing it (decline or X) also sets the flag.

2. **`modelManagerBridge.downloadModel` progress callback shape differs from Parakeet.** It passes `(downloadedBytes, totalBytes)` as two positional args. The Gemma method must construct the progress object manually.

3. **Renaming channels (Task 1.1) changes working code.** All references to `parakeet-auto-download-*` must be updated atomically across 4 files.

4. **`InferenceConfigEditor` is used 4 times.** Simplifying it to 2 tabs affects ALL model settings — dictation cleanup, dictation agent, note formatting, and chat intelligence. This is intentional per the user's requirement.

5. **`_ensureNoteFormattingConfigured` does not override user choice.** It only sets env vars if they're currently empty. If the user has configured a remote endpoint, the auto-config is skipped.

6. **llama-server must exist for Gemma inference.** The binary downloads during `predev`/`prebuild`. If missing at runtime, inference will fail even with the model downloaded. This is an existing requirement, not new.

7. **The prompt should appear AFTER Parakeet download completes** (not during). If both banners and the prompt showed simultaneously, the UX would be overwhelming. The prompt's `useEffect` should subscribe to `useModelAutoDownloadStore` and wait for `isActive === false`.

8. **Mode migration required.** All 4 inference mode settings (`cleanupMode`, `noteFormattingMode`, `dictationAgentMode`, `chatAgentMode`) default to `"openwhispr"` in settingsStore.ts. After removing that mode tab, existing users will have a broken UI. Update all mode initializers to remap `"openwhispr"` / `"providers"` / `"enterprise"` → `"local"` and change the default to `"local"`. See settingsStore.ts lines 1060-1071 and 1115-1126 for the validator functions.

9. **Store reconnection has hardcoded Parakeet values.** `modelAutoDownloadStore.ts` lines 110-116 hardcode `modelName: "Parakeet TDT 0.6B"` and `sizeMb: 680` when the renderer reconnects mid-download. Update `get-model-auto-download-status` handler to return `{ active, modelId, modelName, sizeMb }` and update the store to use returned values.

10. **`_ensureNoteFormattingConfigured` only sets process.env, not the renderer store.** After setting env vars, broadcast `note-formatting-auto-configured` IPC to the renderer so the settings store can update. Without this, the settings UI shows stale values until reload.

11. **Banner must destructure `modelName`.** `ModelDownloadBanner.tsx` currently does NOT include `modelName` in its store destructure. Add it for the interpolation template to work.

12. **`GemmaModelCard` in Task 3.1 needs full implementation.** The current plan references it as a placeholder. It should: check model status via `window.electronAPI?.modelCheck?.("gemma-4-e4b-it-q4_k_m")`, show download progress from `useModelAutoDownloadStore`, and render model name + size + status.
