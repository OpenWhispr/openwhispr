const { clipboard } = require("electron");
const { spawn, exec } = require("child_process");
const { detectAsync: detectActiveApp } = require("./activeAppCapture");
const { marked } = require("marked");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildSystemPrompt(transform) {
  const rules = [];
  if (transform.rules?.makeMoreConcise) rules.push("Make the text more concise");
  if (transform.rules?.rewordForClarity) rules.push("Reword the text for clarity");
  if (transform.rules?.reorderForReadability) rules.push("Reorder sentences for better readability");
  if (transform.rules?.addStructureForReadability) rules.push("Add structure to improve readability");
  if (transform.rules?.removeFrustration) {
    rules.push(
      "Remove frustration, anxiety, or any bad emotion from the text. Always write and transform texts in a way which is direct, polite, professional, and helpful. Always replace bad words with something more polite"
    );
  }

  let prompt =
    "You are a text transformation assistant. Transform the provided text and return ONLY the transformed text — no explanation, no commentary, no quotes.\n\n";

  if (rules.length > 0) {
    prompt += "Apply these rules:\n" + rules.map((r) => `- ${r}`).join("\n");
  }

  if (transform.customPrompt?.trim()) {
    prompt +=
      (rules.length > 0 ? "\n\n" : "") +
      "Additional instructions:\n" +
      transform.customPrompt.trim();
  }

  if (transform.richText) {
    prompt +=
      "\n\nFormat the output using standard Markdown: **bold**, *italic*, - unordered lists, 1. ordered lists, > blockquotes, `inline code`. The output will be converted to HTML and pasted as rich text.";
  }

  return prompt;
}

class TransformManager {
  constructor(windowManager, clipboardManager) {
    this._windowManager = windowManager;
    this._clipboardManager = clipboardManager;
    this._transforms = [];
    this._pending = new Map();
  }

  setTransforms(transforms) {
    this._transforms = Array.isArray(transforms) ? transforms : [];
    this._syncHotkeys();
  }

  getTransforms() {
    return this._transforms;
  }

  _syncHotkeys() {
    const hm = this._windowManager?.hotkeyManager;
    if (!hm) return;

    for (const slotName of [...hm.slots.keys()]) {
      if (slotName.startsWith("transform-")) {
        hm.unregisterSlot(slotName);
      }
    }

    for (const transform of this._transforms) {
      if (!transform.enabled || !transform.hotkey) continue;
      const t = transform;
      hm.registerSlot(`transform-${t.id}`, t.hotkey, () => {
        // Fire the activation cue immediately so the user gets instant feedback —
        // the actual copy/clipboard-poll pipeline below can take up to ~1s.
        this._windowManager?.mainWindow?.webContents.send("transform-activated", { id: t.id });
        this._execute(t).catch((err) => {
          try {
            require("./debugLogger").error(
              "Transform execution failed",
              { id: t.id, error: err.message },
              "transform"
            );
          } catch (_) {}
        });
      });
    }
  }

  handleResult(transformId, result) {
    const p = this._pending.get(transformId);
    if (!p) {
      console.warn(`[Transform] handleResult called but no pending promise for id=${transformId}`);
      return;
    }
    this._pending.delete(transformId);
    clearTimeout(p.timeout);
    console.log(`[Transform] handleResult id=${transformId} resultLength=${result?.length}`);
    p.resolve(result);
  }

  async _execute(transform) {
    // Detect the foreground app before the 50ms sleep so the OS still reports
    // the user's target window (not the Electron overlay) as the active window.
    const activeApp = await detectActiveApp();

    await sleep(50);

    require("./debugLogger").info("[Transform] Activating transform", {
      id: transform.id,
      activeApp,
    });

    // Save and clear clipboard so we can detect a successful Ctrl+C even when
    // the selection is identical to what was already in the clipboard.
    const before = clipboard.readText();
    clipboard.writeText("");

    await this._simulateCopy();

    // Poll up to 800ms for the app to update the clipboard.
    let selectedText = "";
    for (let i = 0; i < 8; i++) {
      await sleep(100);
      selectedText = clipboard.readText();
      if (selectedText) break;
    }

    console.log(`[Transform] _execute id=${transform.id} beforeLength=${before?.length} selectedLength=${selectedText?.length}`);
    if (!selectedText) {
      console.warn("[Transform] No text selected — aborting");
      clipboard.writeText(before); // Restore original clipboard
      return;
    }

    const win = this._windowManager?.mainWindow;
    if (!win || win.isDestroyed()) return;

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(transform.id);
        reject(new Error("Transform timed out after 30s"));
      }, 30000);

      this._pending.set(transform.id, { resolve, reject, timeout });

      win.webContents.send("run-transform", {
        id: transform.id,
        text: selectedText,
        systemPrompt: buildSystemPrompt(transform),
        activeApp: transform.includeActiveApp ? activeApp : undefined,
        richText: transform.richText ?? false,
      });
    });

    if (!result) {
      console.warn("[Transform] Result is empty — skipping paste");
      return;
    }

    console.log(`[Transform] Writing to clipboard and pasting. resultLength=${result.length} richText=${transform.richText ?? false}`);
    if (transform.richText) {
      const html = marked.parse(result);
      const wrappedHtml = `<html><body>${html}</body></html>`;
      clipboard.write({ text: result, html: wrappedHtml });
    } else {
      clipboard.writeText(result);
    }
    await sleep(50);
    await this._simulatePaste();
    console.log("[Transform] Paste simulated");
  }

  _simulateCopy() {
    return new Promise((resolve) => {
      if (process.platform === "win32") {
        const nircmdPath = this._clipboardManager?.getNircmdPath?.();
        if (nircmdPath) {
          const proc = spawn(nircmdPath, ["sendkeypress", "ctrl+c"]);
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          proc.on("close", finish);
          setTimeout(finish, 400);
        } else {
          exec(
            'powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^\' + \'c\')"',
            () => resolve()
          );
        }
      } else if (process.platform === "darwin") {
        exec(
          'osascript -e \'tell application "System Events" to keystroke "c" using command down\'',
          () => resolve()
        );
      } else {
        exec("xdotool key ctrl+c", () => resolve());
      }
    });
  }

  _simulatePaste() {
    return new Promise((resolve) => {
      if (process.platform === "win32") {
        const nircmdPath = this._clipboardManager?.getNircmdPath?.();
        if (nircmdPath) {
          const proc = spawn(nircmdPath, ["sendkeypress", "ctrl+v"]);
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          proc.on("close", finish);
          setTimeout(finish, 400);
        } else {
          exec(
            'powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^\' + \'v\')"',
            () => resolve()
          );
        }
      } else if (process.platform === "darwin") {
        exec(
          'osascript -e \'tell application "System Events" to keystroke "v" using command down\'',
          () => resolve()
        );
      } else {
        exec("xdotool key ctrl+v", () => resolve());
      }
    });
  }

  cleanup() {
    const hm = this._windowManager?.hotkeyManager;
    if (!hm) return;
    for (const slotName of [...hm.slots.keys()]) {
      if (slotName.startsWith("transform-")) {
        hm.unregisterSlot(slotName);
      }
    }
    for (const p of this._pending.values()) {
      clearTimeout(p.timeout);
      p.reject(new Error("TransformManager shutting down"));
    }
    this._pending.clear();
  }
}

module.exports = TransformManager;
