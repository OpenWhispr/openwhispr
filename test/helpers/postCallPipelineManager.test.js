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
        transcript: JSON.stringify([{ text: "hello", speaker: "speaker_0" }]),
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
      transcribeLocalWhisper: async () => ({ text: "hello world", segments: [] }),
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
  fs.readFileSync = (p) => p.includes("ow-pipeline") ? Buffer.from("fake wav") : origReadFile(p);
  fs.unlinkSync = (p) => { if (!p.includes("ow-pipeline")) origUnlink(p); };

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

    // Retranscribe should complete (not error) — it returned null gracefully
    assert.ok(steps.includes("retranscribe:running"));
    assert.ok(steps.includes("retranscribe:complete"));
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
