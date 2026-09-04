const test = require("node:test");
const assert = require("node:assert/strict");

function createMocks() {
  const events = [];
  const broadcast = (channel, payload) => events.push({ channel, ...payload });

  return {
    events,
    broadcast,
    databaseManager: {
      getNote: (id) => ({
        id,
        transcript: JSON.stringify([
          { text: "hello", speaker: "speaker_0", source: "system", timestamp: 0 },
        ]),
        system_audio_path: "/tmp/test.opus",
        mic_audio_path: null,
        meeting_type_id: null,
        audio_duration_seconds: 300,
      }),
      updateNote: () => ({ success: true }),
      getMeetingType: () => null,
      getMeetingTypes: () => [],
    },
    whisperManager: {
      transcribeLocalWhisper: async () => ({
        success: true,
        text: "hello world",
        segments: [{ start: 0, end: 2, text: "hello world" }],
      }),
      getModelPath: () => "/tmp/model.bin",
    },
    diarizationManager: {
      isAvailable: () => false,
    },
    inference: {
      processText: async (text, opts) => {
        if (opts.systemPrompt.includes("title")) return "Test Meeting Title";
        return "## Summary\nTest notes";
      },
    },
    convertToWav: async () => {},
  };
}

test("runs steps in order: retranscribe -> title -> notes", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  const fs = require("fs");
  const origExists = fs.existsSync;
  const origReadFile = fs.readFileSync;
  const origUnlink = fs.unlinkSync;
  fs.existsSync = (p) => (p === "/tmp/test.opus" || p === "/tmp/model.bin") ? true : origExists(p);
  fs.readFileSync = (...args) =>
    typeof args[0] === "string" && args[0].includes("ow-retranscribe")
      ? Buffer.from("fake wav")
      : origReadFile(...args);
  fs.unlinkSync = (p) => { if (!String(p).includes("ow-retranscribe")) origUnlink(p); };

  // Set env vars for inference config
  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    assert.ok(steps.includes("retranscribe:running"));
    assert.ok(steps.includes("retranscribe:complete"));
    assert.ok(steps.includes("title:running"));
    assert.ok(steps.includes("title:complete"));
    assert.ok(steps.includes("notes:running"));
    assert.ok(steps.includes("notes:complete"));

    const retranscribeComplete = steps.indexOf("retranscribe:complete");
    const titleRunning = steps.indexOf("title:running");
    assert.ok(retranscribeComplete < titleRunning);
  } finally {
    fs.existsSync = origExists;
    fs.readFileSync = origReadFile;
    fs.unlinkSync = origUnlink;
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("stops pipeline on error and emits error status", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.whisperManager.transcribeLocalWhisper = async () => { throw new Error("model crashed"); };
  const fs = require("fs");
  const origExists = fs.existsSync;
  const origUnlink = fs.unlinkSync;
  fs.existsSync = (p) => (p === "/tmp/test.opus" || p === "/tmp/model.bin") ? true : origExists(p);
  fs.unlinkSync = () => {};

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    assert.ok(steps.includes("retranscribe:error"));
    assert.ok(!steps.includes("title:running"));
  } finally {
    fs.existsSync = origExists;
    fs.unlinkSync = origUnlink;
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("skips retranscribe when no saved audio, proceeds to title", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "hello" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    assert.ok(steps.includes("retranscribe:skipped"));
    assert.ok(steps.includes("title:running"));
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("uses meeting type template for note generation when set", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  let capturedPrompt = null;
  mocks.inference.processText = async (text, opts) => {
    if (opts.systemPrompt.includes("meeting notes assistant")) capturedPrompt = opts.systemPrompt;
    return "## Notes";
  };
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "standup update" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: 1,
  });
  mocks.databaseManager.getMeetingType = (id) => ({
    id,
    name: "Standup",
    template: "For each speaker: yesterday, today, blockers. End with Action Items.",
  });

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);
    assert.ok(capturedPrompt.includes("yesterday, today, blockers"));
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("fromStep skips earlier steps", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "hello" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1, { fromStep: "notes" });

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    assert.ok(!steps.includes("retranscribe:running"));
    assert.ok(!steps.includes("title:running"));
    assert.ok(steps.includes("notes:running"));
    assert.ok(steps.includes("notes:complete"));
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("STEP_ORDER includes classify between title and notes", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  // Access the module-level STEP_ORDER via a pipeline run and check step ordering
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "standup update" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });
  mocks.databaseManager.getMeetingTypes = () => [];

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    // classify should appear after title and before notes
    const classifyIdx = steps.findIndex((s) => s.startsWith("classify:"));
    const titleComplete = steps.indexOf("title:complete");
    const notesRunning = steps.indexOf("notes:running");

    assert.ok(classifyIdx > -1, "classify step should appear in pipeline");
    assert.ok(titleComplete < classifyIdx, "classify should come after title:complete");
    assert.ok(classifyIdx < notesRunning, "classify should come before notes:running");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("classify step skips when meeting_type_id already set", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "standup update" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: 3,
  });
  mocks.databaseManager.getMeetingTypes = () => [
    { id: 1, name: "Standup", keyword_rules: '["standup"]' },
    { id: 3, name: "Retro", keyword_rules: '["retro"]' },
  ];
  mocks.databaseManager.getMeetingType = (id) => ({ id, name: "Retro", template: "Retro template" });
  let updateCalled = false;
  const origUpdate = mocks.databaseManager.updateNote;
  mocks.databaseManager.updateNote = (id, updates) => {
    if (updates.meeting_type_id !== undefined) updateCalled = true;
    return origUpdate(id, updates);
  };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    // classify should complete but not update meeting_type_id
    assert.ok(!updateCalled, "should not update meeting_type_id when already set");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("classify step uses LLM to detect meeting type", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "let's discuss yesterday's progress and today's plan" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });
  mocks.databaseManager.getMeetingTypes = () => [
    { id: 1, name: "Standup", keyword_rules: '["standup"]' },
    { id: 2, name: "Planning", keyword_rules: '["planning"]' },
  ];
  mocks.databaseManager.getMeetingType = () => null;

  let classifyUpdateId = null;
  mocks.databaseManager.updateNote = (id, updates) => {
    if (updates.meeting_type_id !== undefined) classifyUpdateId = updates.meeting_type_id;
    return { success: true };
  };

  // LLM returns the id "1" for Standup
  mocks.inference.processText = async (text, opts) => {
    if (opts.systemPrompt.includes("meeting classifier")) return "1";
    if (opts.systemPrompt.includes("title")) return "Daily Standup";
    return "## Notes";
  };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    assert.equal(classifyUpdateId, 1, "should set meeting_type_id to LLM-detected value");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("classify step falls back to keyword matching when no LLM configured", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "let's do our standup. what did everyone do yesterday?" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });
  mocks.databaseManager.getMeetingTypes = () => [
    { id: 1, name: "Standup", keyword_rules: '["standup"]' },
    { id: 2, name: "Planning", keyword_rules: '["planning", "sprint"]' },
  ];

  let classifyUpdateId = null;
  mocks.databaseManager.updateNote = (id, updates) => {
    if (updates.meeting_type_id !== undefined) classifyUpdateId = updates.meeting_type_id;
    return { success: true };
  };

  // No LLM configured
  delete process.env.NOTE_FORMATTING_PROVIDER;
  delete process.env.NOTE_FORMATTING_MODEL;

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    assert.equal(classifyUpdateId, 1, "should fall back to keyword match and set standup type");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("classify step errors do not halt the pipeline", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([{ text: "hello world" }]),
    system_audio_path: null,
    mic_audio_path: null,
    meeting_type_id: null,
  });
  // getMeetingTypes throws to simulate a database error
  mocks.databaseManager.getMeetingTypes = () => { throw new Error("db connection lost"); };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    // classify should error but notes should still run
    assert.ok(steps.includes("classify:error"), "classify should report error");
    assert.ok(steps.includes("notes:running"), "notes should still run after classify error");
    assert.ok(steps.includes("notes:complete"), "notes should complete after classify error");
    assert.ok(steps.includes("pipeline:complete"), "pipeline should complete");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("skips retranscribe when large model not downloaded yet", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  // whisperManager.getModelPath returns a path that doesn't exist on disk
  mocks.whisperManager.getModelPath = () => "/tmp/nonexistent-model-path.bin";
  const fs = require("fs");
  const origExists = fs.existsSync;
  // Audio file exists, but model file does not
  fs.existsSync = (p) => {
    if (p === "/tmp/test.opus") return true;
    if (p === "/tmp/nonexistent-model-path.bin") return false;
    return origExists(p);
  };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    const steps = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status")
      .map((e) => `${e.step}:${e.status}`);

    // The step has not run, so it must report pending and NOT complete: the drain queue
    // keys off this note staying pending until the model download finishes.
    assert.ok(steps.includes("retranscribe:running"));
    assert.ok(steps.includes("retranscribe:pending"));
    assert.ok(!steps.includes("retranscribe:complete"));
    assert.ok(!steps.some((s) => s === "retranscribe:error"));

    // Title and notes should still run using the existing transcript
    assert.ok(steps.includes("title:running"));
    assert.ok(steps.includes("title:complete"));
    assert.ok(steps.includes("notes:running"));
    assert.ok(steps.includes("notes:complete"));
    assert.ok(steps.includes("pipeline:complete"));
  } finally {
    fs.existsSync = origExists;
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("a preserved re-transcription writes no transcript and is not marked pending", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  // Dual-source transcript with only one track on disk: rewriting it from the system
  // track alone would throw away everything the user said.
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([
      { text: "them", speaker: "speaker_0", source: "system", timestamp: 0 },
      { text: "me", speaker: "you", source: "mic", timestamp: 5 },
    ]),
    system_audio_path: "/tmp/test.opus",
    mic_audio_path: null,
    meeting_type_id: null,
  });
  const transcriptWrites = [];
  mocks.databaseManager.updateNote = (id, updates) => {
    if (updates.transcript !== undefined) transcriptWrites.push(updates.transcript);
    return { success: true };
  };

  const fs = require("fs");
  const origExists = fs.existsSync;
  fs.existsSync = (p) => (p === "/tmp/test.opus" || p === "/tmp/model.bin" ? true : origExists(p));

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    assert.deepEqual(transcriptWrites, [], "must not overwrite a transcript it cannot replace");

    const retranscribe = mocks.events.filter(
      (e) => e.channel === "post-call-pipeline-status" && e.step === "retranscribe"
    );
    const terminal = retranscribe.at(-1);
    assert.equal(terminal.status, "complete");
    assert.equal(terminal.preserved, true);
    assert.equal(terminal.reason, "incomplete-source-coverage");
    assert.ok(
      !retranscribe.some((e) => e.status === "pending"),
      "preserved must not leak into the pending-retranscription set"
    );
  } finally {
    fs.existsSync = origExists;
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("a preserved re-transcription still runs the later steps on the kept transcript", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript: JSON.stringify([
      { text: "the kept words", speaker: "speaker_0", source: "system", timestamp: 0 },
      { text: "and my half", speaker: "you", source: "mic", timestamp: 5 },
    ]),
    system_audio_path: "/tmp/test.opus",
    mic_audio_path: null,
    meeting_type_id: null,
  });
  const titleInputs = [];
  mocks.inference.processText = async (text, opts) => {
    // The notes prompt also mentions "title", so match the title prompt itself.
    if (opts.systemPrompt.startsWith("Generate a concise")) {
      titleInputs.push(text);
      return "Kept Title";
    }
    return "## Notes";
  };

  const fs = require("fs");
  const origExists = fs.existsSync;
  fs.existsSync = (p) => (p === "/tmp/test.opus" || p === "/tmp/model.bin" ? true : origExists(p));

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1);

    assert.equal(titleInputs.length, 1);
    assert.ok(
      titleInputs[0].includes("and my half"),
      "the kept transcript covers both sides, so it beats a system-only re-transcription"
    );
  } finally {
    fs.existsSync = origExists;
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

// The tests above assert on broadcast status events. A step can emit
// "complete" without having written anything, so assert the actual writes too.
test("the title step writes the generated title to the note", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  const writes = [];
  mocks.databaseManager.updateNote = (id, updates) => {
    writes.push({ id, updates });
    return { success: true };
  };

  // The shared mock keys off the prompt containing "title", which both the
  // title and notes prompts do. Distinguish by call order instead.
  let call = 0;
  mocks.inference.processText = async () => {
    call += 1;
    return call === 1 ? "Test Meeting Title" : "## Summary\nGenerated notes body";
  };

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.run(1, { fromStep: "title" });

    const titleWrite = writes.find((w) => w.updates.title !== undefined);
    assert.ok(titleWrite, "the pipeline must persist a title, not merely report title:complete");
    assert.equal(titleWrite.updates.title, "Test Meeting Title");

    const notesWrite = writes.find((w) => w.updates.enhanced_content !== undefined);
    assert.ok(notesWrite, "the pipeline must persist generated notes");
    assert.match(notesWrite.updates.enhanced_content, /Generated notes body/);
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

// Regression: an unconfigured noteFormatting scope once shipped as a release
// that generated no titles and no notes, because _getInferenceConfig returns
// null and every AI step is skipped without surfacing an error.
test("no title or notes are written when noteFormatting is unconfigured", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = createMocks();
  const writes = [];
  mocks.databaseManager.updateNote = (id, updates) => {
    writes.push({ id, updates });
    return { success: true };
  };
  let inferenceCalls = 0;
  mocks.inference.processText = async () => {
    inferenceCalls += 1;
    return "should not be reached";
  };

  delete process.env.NOTE_FORMATTING_PROVIDER;
  delete process.env.NOTE_FORMATTING_MODEL;

  const manager = new PostCallPipelineManager({
    broadcast: mocks.broadcast,
    databaseManager: mocks.databaseManager,
    whisperManager: mocks.whisperManager,
    diarizationManager: mocks.diarizationManager,
    inference: mocks.inference,
    convertToWav: mocks.convertToWav,
  });

  await manager.run(1, { fromStep: "title" });

  assert.equal(inferenceCalls, 0, "no model should be called without a configured provider");
  assert.equal(
    writes.find((w) => w.updates.title !== undefined),
    undefined,
    "an unconfigured pipeline must not invent a title"
  );
});

// ── Long transcripts (1.17.0) ──────────────────────────────────────────────
//
// The notes step used to send `text.slice(0, 8000)` in a single call. On a local
// model that is a hard failure ("Prompt is too long ... budget of 1228"); on a
// cloud model it silently discarded everything past about 25 minutes of meeting.

const LONG_SEGMENTS = Array.from({ length: 400 }, (_, i) => ({
  text: `Segment ${i}: we discussed the quarterly rollout and agreed on the staffing plan.`,
  speaker: `speaker_${i % 3}`,
  source: "system",
  timestamp: i,
}));

function longTranscriptMocks(createMocks) {
  const mocks = createMocks();
  const transcript = JSON.stringify(LONG_SEGMENTS);
  mocks.databaseManager.getNote = (id) => ({
    id,
    transcript,
    system_audio_path: "/tmp/test.opus",
    mic_audio_path: null,
    meeting_type_id: null,
    audio_duration_seconds: 3600,
  });
  return mocks;
}

function recordingInference(mocks) {
  const calls = [];
  mocks.inference.processText = async (text, opts) => {
    calls.push({ text, opts });
    if (opts.systemPrompt?.includes("extracting source material")) return "DECISIONS: rollout agreed.";
    return "## Summary\nTest notes";
  };
  return calls;
}

test("a local model chunks a long transcript instead of failing on it", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = longTranscriptMocks(createMocks);
  const calls = recordingInference(mocks);

  process.env.NOTE_FORMATTING_PROVIDER = "local";
  process.env.NOTE_FORMATTING_MODEL = "gemma-4-e4b";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
      resolveModelContext: async () => ({ contextSize: 8192, isGpuBackend: true }),
    });

    await manager.runSingleStep(1, "notes");

    const statuses = mocks.events
      .filter((e) => e.channel === "post-call-pipeline-status" && e.step === "notes")
      .map((e) => e.status);
    assert.ok(statuses.includes("complete"), `notes did not complete: ${statuses.join(",")}`);
    assert.ok(calls.length > 1, `expected several passes, got ${calls.length}`);

    // Nothing may be dropped: the last segment has to reach an extraction.
    const seen = calls.map((c) => c.text).join("\n");
    assert.ok(seen.includes("Segment 399"), "the tail of the transcript never reached the model");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("a model family in the provider field still takes the local path", async () => {
  // Settings has been seen persisting "gemma" into the provider field. Sending
  // that down the cloud branch would put the whole transcript in one local call.
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = longTranscriptMocks(createMocks);
  const calls = recordingInference(mocks);
  let resolvedContext = false;

  process.env.NOTE_FORMATTING_PROVIDER = "gemma";
  process.env.NOTE_FORMATTING_MODEL = "google_gemma-4-E4B-it-Q4_K_M.gguf";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
      resolveModelContext: async () => {
        resolvedContext = true;
        return { contextSize: 8192, isGpuBackend: true };
      },
    });

    await manager.runSingleStep(1, "notes");

    assert.ok(resolvedContext, "a family-labelled local model must resolve a context");
    assert.ok(calls.length > 1, `expected several passes, got ${calls.length}`);
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("a cloud model gets the whole transcript, not the first 8000 characters", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = longTranscriptMocks(createMocks);
  const calls = recordingInference(mocks);
  let resolvedContext = false;

  process.env.NOTE_FORMATTING_PROVIDER = "openai";
  process.env.NOTE_FORMATTING_MODEL = "gpt-5.5";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
      resolveModelContext: async () => {
        resolvedContext = true;
        return { contextSize: 8192, isGpuBackend: true };
      },
    });

    await manager.runSingleStep(1, "notes");

    assert.equal(calls.length, 1, "a cloud model needs exactly one call");
    assert.ok(calls[0].text.includes("Segment 399"), "the transcript was truncated");
    assert.equal(resolvedContext, false, "resolveModelContext throws for cloud model ids");
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});

test("without a context resolver a local model falls back to a single call", async () => {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const mocks = longTranscriptMocks(createMocks);
  const calls = recordingInference(mocks);

  process.env.NOTE_FORMATTING_PROVIDER = "local";
  process.env.NOTE_FORMATTING_MODEL = "gemma-4-e4b";

  try {
    const manager = new PostCallPipelineManager({
      broadcast: mocks.broadcast,
      databaseManager: mocks.databaseManager,
      whisperManager: mocks.whisperManager,
      diarizationManager: mocks.diarizationManager,
      inference: mocks.inference,
      convertToWav: mocks.convertToWav,
    });

    await manager.runSingleStep(1, "notes");

    assert.equal(calls.length, 1);
  } finally {
    delete process.env.NOTE_FORMATTING_PROVIDER;
    delete process.env.NOTE_FORMATTING_MODEL;
  }
});
