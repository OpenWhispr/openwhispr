const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Untranslated i18n fallback: t() returns the key, so the markup names the string shown.
async function renderFailedRow(t, { errorCode, errorMessage }) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-history-failed-row-test-",
  });
  const { default: TranscriptionItem } = await vite.ssrLoadModule(
    "/components/ui/TranscriptionItem.tsx"
  );
  return renderToStaticMarkup(
    createElement(TranscriptionItem, {
      item: {
        id: 1,
        text: "",
        raw_text: null,
        timestamp: "2026-09-25T10:00:00",
        created_at: "2026-09-25T10:00:00",
        has_audio: 1,
        audio_duration_ms: 1200,
        provider: null,
        model: null,
        status: "failed",
        error_message: errorMessage,
        error_code: errorCode,
        client_transcription_id: "row-1",
        cloud_id: null,
        sync_status: "synced",
        deleted_at: null,
      },
      onCopy: () => {},
      onDelete: () => {},
    })
  );
}

// A dictation OpenRouter refused for lack of credit is saved with its raw reply,
// which History printed verbatim under "Transcription failed".
test("a failed row out of OpenRouter credit says so, not the raw reply", async (t) => {
  const html = await renderFailedRow(t, {
    errorCode: "OPENROUTER_OUT_OF_CREDITS",
    errorMessage: `API Error: 402 ${JSON.stringify({
      error: {
        code: 402,
        message: "Insufficient credits. Add more using https://openrouter.ai/credits",
      },
    })}`,
  });

  assert.ok(html.includes("hooks.audioRecording.errorDescriptions.openrouterOutOfCredits"));
  assert.ok(!html.includes("API Error: 402"), "the raw provider reply is not shown");
});

test("other failed rows keep showing the saved error", async (t) => {
  const html = await renderFailedRow(t, {
    errorCode: null,
    errorMessage: "API Error: 500 upstream unavailable",
  });

  assert.ok(html.includes("API Error: 500 upstream unavailable"));
  assert.ok(!html.includes("openrouterOutOfCredits"));
});
