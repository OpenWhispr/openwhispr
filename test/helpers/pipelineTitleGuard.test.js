const test = require("node:test");
const assert = require("node:assert/strict");

// The post-call pipeline runs automatically after every meeting, and also from
// "retry step" and "reprocess all meetings". Its title step used to write
// unconditionally, which silently renamed notes the user had titled themselves.

function createHarness({ note = {}, calendarEvents = {}, onTitlePrompt } = {}) {
  const writes = [];
  const db = {
    _note: {
      id: 1,
      title: "",
      calendar_event_id: null,
      transcript: JSON.stringify([{ text: "hello there" }]),
      system_audio_path: null,
      mic_audio_path: null,
      meeting_type_id: null,
      ...note,
    },
    getNote() {
      return { ...this._note };
    },
    updateNote(id, updates) {
      writes.push({ id, updates });
      Object.assign(this._note, updates);
      return { success: true };
    },
    getMeetingType: () => null,
    getMeetingTypes: () => [],
    getCalendarEventById: (eventId) => calendarEvents[eventId] ?? null,
  };

  const inference = {
    processText: async (_text, opts) => {
      if (opts.systemPrompt.startsWith("Generate a concise")) {
        onTitlePrompt?.(db);
        return "LLM Generated Title";
      }
      return "## Notes";
    },
  };

  return { db, writes, inference };
}

async function runTitleStep(harness) {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";
  try {
    const manager = new PostCallPipelineManager({
      broadcast: () => {},
      databaseManager: harness.db,
      whisperManager: {},
      diarizationManager: { isAvailable: () => false },
      inference: harness.inference,
      convertToWav: async () => {},
    });
    await manager.run(1, { fromStep: "title" });
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
  return harness.writes.find((w) => w.updates.title !== undefined);
}

test("a title the user typed is never overwritten by the pipeline", async () => {
  const harness = createHarness({ note: { title: "Q3 Roadmap Decisions" } });
  const titleWrite = await runTitleStep(harness);

  assert.equal(titleWrite, undefined, "a user-chosen title must survive the pipeline");
  assert.ok(
    harness.writes.some((w) => w.updates.enhanced_content !== undefined),
    "the rest of the pipeline must still run"
  );
});

test("an empty title is generated", async () => {
  const harness = createHarness({ note: { title: "" } });
  assert.equal((await runTitleStep(harness))?.updates.title, "LLM Generated Title");
});

test("an English placeholder title is regenerated", async () => {
  const harness = createHarness({ note: { title: "Untitled Note" } });
  assert.equal((await runTitleStep(harness))?.updates.title, "LLM Generated Title");
});

// Notes are created with a *localized* placeholder, so an English-only guard
// would silently stop generating titles for every non-English user.
test("a localized placeholder title is regenerated", async () => {
  const spanish = createHarness({ note: { title: "Nota sin título" } });
  assert.equal((await runTitleStep(spanish))?.updates.title, "LLM Generated Title");

  const german = createHarness({ note: { title: "Neue Notiz" } });
  assert.equal((await runTitleStep(german))?.updates.title, "LLM Generated Title");
});

test("an unedited calendar event summary is regenerated", async () => {
  const harness = createHarness({
    note: { title: "Weekly Team Sync", calendar_event_id: "evt-1" },
    calendarEvents: { "evt-1": { id: "evt-1", summary: "Weekly Team Sync" } },
  });
  assert.equal((await runTitleStep(harness))?.updates.title, "LLM Generated Title");
});

// calendar_events rows are purged on sync/account cleanup, so a late reprocess
// can no longer prove the title came from the event. Fail closed.
test("a purged calendar event makes the guard fail closed", async () => {
  const harness = createHarness({
    note: { title: "Weekly Team Sync", calendar_event_id: "evt-gone" },
    calendarEvents: {},
  });
  assert.equal(
    await runTitleStep(harness),
    undefined,
    "without the event to compare against, the title must be kept"
  );
});

// Re-transcription can take minutes with the large model, so the note loaded at
// the top of run() is stale by the time the title is written.
test("a title typed while the pipeline runs is not overwritten", async () => {
  const harness = createHarness({
    note: { title: "" },
    onTitlePrompt: (db) => {
      db._note.title = "Typed while the pipeline was running";
    },
  });
  assert.equal(
    await runTitleStep(harness),
    undefined,
    "the guard must re-read the title immediately before the write"
  );
});
