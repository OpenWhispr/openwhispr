const fs = require("fs");
const path = require("path");
const os = require("os");
const debugLogger = require("./debugLogger");
const { computeTranscriptDiff } = require("./transcriptDiff");

const STEP_ORDER = ["retranscribe", "title", "classify", "notes"];

const GENERIC_NOTES_PROMPT = `You are a professional meeting notes assistant. You will receive a transcript with speaker labels.

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no date/time, no attendee list. Start directly with the summary.
- Do NOT use tables, horizontal rules, or block quotes.
- Start with a concise 1-2 sentence summary.
- Use clear section headings: ## Key Discussion Points, ## Decisions Made, ## Action Items, ## Follow-ups (omit any section that has no content).
- Under Action Items, use checkboxes (- [ ]) and attribute each item to the speaker where clear.
- Keep the tone professional and concise. Bias toward brevity.`;

const TITLE_PROMPT =
  "Generate a concise 3-8 word title for this meeting transcript. Return ONLY the title text, nothing else — no quotes, no prefix, no explanation.";

class PostCallPipelineManager {
  constructor({ broadcast, databaseManager, whisperManager, diarizationManager, inference, convertToWav }) {
    this._broadcast = broadcast;
    this._db = databaseManager;
    this._whisper = whisperManager;
    this._diarization = diarizationManager;
    this._inference = inference;
    this._convertToWav = convertToWav;
  }

  async run(noteId, options = {}) {
    const note = this._db.getNote(noteId);
    if (!note) {
      this._emitStatus(noteId, "retranscribe", "error", "Note not found");
      return;
    }

    const fromIndex = options.fromStep ? STEP_ORDER.indexOf(options.fromStep) : 0;
    let transcript = note.transcript;

    // Step 1: Re-transcribe
    if (fromIndex <= 0) {
      const audioPath = note.system_audio_path || note.mic_audio_path;
      const hasAudio = audioPath && fs.existsSync(audioPath);

      if (hasAudio) {
        const result = await this._runStep(noteId, "retranscribe", () =>
          this._retranscribe(noteId, audioPath, note.audio_duration_seconds)
        );
        if (result.error) return;
        if (result.value) transcript = result.value;
      } else {
        this._emitStatus(noteId, "retranscribe", "skipped");
      }
    }

    // Step 2: Generate title
    if (fromIndex <= 1) {
      const titleResult = await this._runStep(noteId, "title", () =>
        this._generateTitle(transcript)
      );
      if (titleResult.error) return;
      if (titleResult.value) {
        this._db.updateNote(noteId, { title: titleResult.value });
        this._broadcastNoteUpdate(noteId);
      }
    }

    // Step 3: Classify meeting type (non-fatal — errors don't halt pipeline)
    if (fromIndex <= 2) {
      try {
        const classifyResult = await this._runStep(noteId, "classify", () =>
          this._classifyMeetingType(noteId, transcript)
        );
        if (!classifyResult.error && classifyResult.value) {
          this._db.updateNote(noteId, { meeting_type_id: classifyResult.value });
          this._broadcastNoteUpdate(noteId);
        }
      } catch (err) {
        debugLogger.warn("Pipeline: classify step failed (non-fatal)", { noteId, error: err.message }, "meeting");
        this._emitStatus(noteId, "classify", "error", err.message);
      }
    }

    // Step 4: Generate notes
    if (fromIndex <= 3) {
      const notesResult = await this._runStep(noteId, "notes", () =>
        this._generateNotes(noteId, transcript)
      );
      if (notesResult.error) return;
      if (notesResult.value) {
        this._db.updateNote(noteId, { enhanced_content: notesResult.value });
        this._broadcastNoteUpdate(noteId);
      }
    }

    this._emitStatus(noteId, "pipeline", "complete");
  }

  async runSingleStep(noteId, step) {
    const note = this._db.getNote(noteId);
    if (!note) {
      this._emitStatus(noteId, step, "error", "Note not found");
      return;
    }

    const transcript = note.transcript || note.content;

    if (step === "notes") {
      const result = await this._runStep(noteId, "notes", () =>
        this._generateNotes(noteId, transcript)
      );
      if (!result.error && result.value) {
        this._db.updateNote(noteId, { enhanced_content: result.value });
        this._broadcastNoteUpdate(noteId);
      }
    } else if (step === "classify") {
      const result = await this._runStep(noteId, "classify", () =>
        this._classifyMeetingType(noteId, transcript)
      );
      if (!result.error && result.value) {
        this._db.updateNote(noteId, { meeting_type_id: result.value });
        this._broadcastNoteUpdate(noteId);
      }
    } else if (step === "title") {
      const result = await this._runStep(noteId, "title", () =>
        this._generateTitle(transcript)
      );
      if (!result.error && result.value) {
        this._db.updateNote(noteId, { title: result.value });
        this._broadcastNoteUpdate(noteId);
      }
    }

    this._emitStatus(noteId, "pipeline", "complete");
  }

  async _runStep(noteId, step, fn) {
    this._emitStatus(noteId, step, "running");
    try {
      const value = await fn();
      this._emitStatus(noteId, step, "complete");
      return { value };
    } catch (err) {
      debugLogger.error(`Pipeline step ${step} failed`, { noteId, error: err.message }, "meeting");
      this._emitStatus(noteId, step, "error", err.message);
      return { error: err.message };
    }
  }

  async _retranscribe(noteId, audioPath, audioDurationSec) {
    // Guard: skip if the large model hasn't been downloaded yet
    const largeModelPath = this._whisper.getModelPath("large");
    if (!fs.existsSync(largeModelPath)) {
      debugLogger.warn("Pipeline: large whisper model not downloaded yet, skipping retranscribe",
        { modelPath: largeModelPath }, "meeting");
      return null;
    }

    // Sub-stage 1: Convert Opus to WAV for whisper
    this._emitSubStage(noteId, "retranscribe", "converting");
    const tmpWav = path.join(os.tmpdir(), `ow-pipeline-${noteId}-${Date.now()}.wav`);
    await this._convertToWav(audioPath, tmpWav, { sampleRate: 16000, channels: 1 });

    try {
      // Sub-stage 2: Transcribe with large model
      this._emitSubStage(noteId, "retranscribe", "transcribing");
      const wavBuffer = fs.readFileSync(tmpWav);
      const result = await this._whisper.transcribeLocalWhisper(wavBuffer, {
        model: "large",
        language: null,
      });

      const rawText = result?.text || "";
      if (!rawText.trim()) throw new Error("Re-transcription produced empty output");

      // Save old transcript for diff
      const oldNote = this._db.getNote(noteId);
      const oldTranscript = oldNote?.transcript;

      let finalTranscript = rawText;

      // Sub-stage 3: Re-diarize if possible
      const note = this._db.getNote(noteId);
      const systemPath = note?.system_audio_path;
      if (systemPath && fs.existsSync(systemPath) && this._diarization?.isAvailable()) {
        this._emitSubStage(noteId, "retranscribe", "diarizing");
        try {
          const diarWav = path.join(os.tmpdir(), `ow-pipeline-diar-${noteId}-${Date.now()}.wav`);
          await this._convertToWav(systemPath, diarWav, { sampleRate: 16000, channels: 1 });

          const diarResult = await this._diarization.diarize(diarWav, {});
          if (diarResult?.segments?.length) {
            const whisperSegments = (result.segments || []).map((seg, i) => ({
              id: `retranscribe-${i}`,
              text: seg.text,
              source: "system",
              timestamp: (seg.start || 0) * 1000,
            }));
            const enriched = this._diarization.mergeWithTranscript(whisperSegments, diarResult.segments);
            if (enriched?.length) {
              finalTranscript = JSON.stringify(enriched);
            }
          }
          try { fs.unlinkSync(diarWav); } catch (_) {}
        } catch (diarErr) {
          debugLogger.warn("Pipeline re-diarization failed, using raw text",
            { error: diarErr.message }, "meeting");
        }
      }

      this._db.updateNote(noteId, { transcript: finalTranscript });

      // Compute diff and emit with completion
      const diff = computeTranscriptDiff(oldTranscript, finalTranscript);
      this._broadcast("post-call-pipeline-status", {
        noteId, step: "retranscribe", status: "complete", diff,
      });

      this._broadcastNoteUpdate(noteId);
      return finalTranscript;
    } finally {
      try { fs.unlinkSync(tmpWav); } catch (_) {}
    }
  }

  async _generateTitle(transcript) {
    const config = this._getInferenceConfig();
    if (!config) return null;

    const text = this._flattenTranscript(transcript);
    const title = await this._inference.processText(text.slice(0, 2000), {
      ...config,
      systemPrompt: TITLE_PROMPT,
      temperature: 0.3,
    });

    const cleaned = title.trim().replace(/^["']|["']$/g, "");
    return cleaned.length > 0 && cleaned.length < 100 ? cleaned : null;
  }

  async _classifyMeetingType(noteId, transcript) {
    // Skip if meeting_type_id is already set (calendar auto-map or user selection)
    const note = this._db.getNote(noteId);
    if (note?.meeting_type_id) {
      debugLogger.info("Pipeline: classify skipped — meeting_type_id already set",
        { noteId, meetingTypeId: note.meeting_type_id }, "meeting");
      return null;
    }

    const types = this._db.getMeetingTypes();
    if (!types || types.length === 0) return null;

    const text = this._flattenTranscript(transcript);

    // Try LLM classification first
    const config = this._getInferenceConfig();
    if (config) {
      try {
        const typeList = types.map((t) => `- "${t.name}" (id: ${t.id})`).join("\n");
        const classifyPrompt = `You are a meeting classifier. Given the transcript excerpt below, determine which meeting type it best matches from this list:

${typeList}

Reply with ONLY the numeric id of the best matching meeting type. If none match well, reply with "none".`;

        const result = await this._inference.processText(text.slice(0, 2000), {
          ...config,
          systemPrompt: classifyPrompt,
          temperature: 0,
        });

        const match = result.trim().match(/^\d+$/);
        const matchedId = match ? parseInt(match[0], 10) : NaN;
        if (!isNaN(matchedId) && types.some((t) => t.id === matchedId)) {
          debugLogger.info("Pipeline: LLM classified meeting type",
            { noteId, meetingTypeId: matchedId }, "meeting");
          return matchedId;
        }
        debugLogger.info("Pipeline: LLM returned no match or invalid id",
          { noteId, raw: result.trim().slice(0, 50) }, "meeting");
      } catch (llmErr) {
        debugLogger.warn("Pipeline: LLM classification failed, falling back to keywords",
          { noteId, error: llmErr.message }, "meeting");
      }
    }

    // Fallback: keyword_rules matching against transcript content
    const lowerText = text.toLowerCase();
    for (const type of types) {
      if (!type.keyword_rules) continue;
      try {
        const keywords = JSON.parse(type.keyword_rules);
        if (Array.isArray(keywords) && keywords.some((kw) => lowerText.includes(kw.toLowerCase()))) {
          debugLogger.info("Pipeline: keyword-matched meeting type",
            { noteId, meetingTypeId: type.id, typeName: type.name }, "meeting");
          return type.id;
        }
      } catch { continue; }
    }

    debugLogger.info("Pipeline: no meeting type matched", { noteId }, "meeting");
    return null;
  }

  async _generateNotes(noteId, transcript) {
    const config = this._getInferenceConfig();
    if (!config) return null;

    const note = this._db.getNote(noteId);
    let systemPrompt = GENERIC_NOTES_PROMPT;

    if (note?.meeting_type_id) {
      const meetingType = this._db.getMeetingType(note.meeting_type_id);
      if (meetingType?.template) {
        systemPrompt = `You are a professional meeting notes assistant. You will receive a transcript with speaker labels.

Meeting type: ${meetingType.name}

Template instructions:
${meetingType.template}

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no date/time, no attendee list. Start directly with the content.
- Do NOT use tables, horizontal rules, or block quotes.
- Follow the template structure above.
- Always include an Action Items section with checkboxes (- [ ]).
- Keep the tone professional and concise.`;
      }
    }

    const text = this._flattenTranscript(transcript);
    return this._inference.processText(text.slice(0, 8000), {
      ...config,
      systemPrompt,
    });
  }

  _getInferenceConfig() {
    const provider = process.env.NOTE_FORMATTING_PROVIDER;
    const model = process.env.NOTE_FORMATTING_MODEL;
    if (!provider || !model) {
      debugLogger.warn("Pipeline: no noteFormatting provider/model configured, skipping AI step", {}, "meeting");
      return null;
    }
    return { provider, model, temperature: 0.3 };
  }

  _flattenTranscript(transcript) {
    if (typeof transcript !== "string") return String(transcript);
    if (!transcript.startsWith("[")) return transcript;
    try {
      const segments = JSON.parse(transcript);
      return segments
        .map((s) => {
          const speaker = s.speakerName || s.speaker || "";
          return speaker ? `${speaker}: ${s.text}` : s.text;
        })
        .join("\n");
    } catch {
      return transcript;
    }
  }

  _emitStatus(noteId, step, status, error = null) {
    const payload = { noteId, step, status };
    if (error) payload.error = error;
    this._broadcast("post-call-pipeline-status", payload);
  }

  _emitSubStage(noteId, step, subStage) {
    this._broadcast("post-call-pipeline-status", {
      noteId, step, status: "running", subStage,
    });
  }

  _broadcastNoteUpdate(noteId) {
    const note = this._db.getNote(noteId);
    if (note) this._broadcast("note-updated", note);
  }
}

module.exports = { PostCallPipelineManager };
