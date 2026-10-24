import { buildWav } from "../utils/wavBuilder";
import { CONTINUOUS_SAMPLE_RATE, ContinuousSegmenter } from "./continuousSegmenter";

// Whisper writes noises it hears as tags: "[BLANK_AUDIO]", "*sniff*", "♪",
// "(coughs)". Bracketed and starred tags never come from speech, so they go
// wherever they appear; a parenthesis is only dropped when it is the whole
// phrase, since a dictated aside can be one.
export function withoutSoundTags(text) {
  const stripped = text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\*[^*]+\*/g, " ")
    .replace(/[♪♫]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^\([^)]*\)[.!?]?$/.test(stripped) ? "" : stripped;
}

// Whisper punctuates every chunk as a whole sentence. A chunk cut while the
// user kept talking loses its closing period, and the chunk after it starts in
// lowercase, so the pieces read as the one sentence that was spoken. "I",
// "I'm" and acronyms keep their capitals; a name at a cut does lose its own.
export function joinChunk(text, { continuesSentence, endsMidSentence }) {
  let joined = text;
  if (endsMidSentence) joined = joined.replace(/(?<!\.)\.$/, "");
  if (continuesSentence) {
    const firstWord = joined.match(/^\p{L}[\p{L}']*/u)?.[0] ?? "";
    const keepsCapital =
      firstWord === "I" || /^I'/.test(firstWord) || firstWord === firstWord.toUpperCase();
    if (firstWord && !keepsCapital && firstWord.slice(1) === firstWord.slice(1).toLowerCase()) {
      joined = joined[0].toLowerCase() + joined.slice(1);
    }
  }
  return joined;
}

// One continuous dictation: the mic stays open, every phrase is transcribed and
// pasted when the user pauses, and Enter is pressed once they stay silent long
// enough. Transcriptions, pastes and Enters run one at a time, in the order the
// phrases were spoken, so an Enter never overtakes the text it submits.
//
// Audio wiring is separate from the queue (`feed`), so tests drive the queue
// with PCM frames and fake dependencies.
export class ContinuousDictationSession {
  constructor({
    submitSilenceMs,
    transcribe,
    deliver,
    pressEnter,
    onMessageComplete,
    onSegmentError,
    logger,
    segmenterOptions = {},
  }) {
    this._transcribe = transcribe;
    this._deliver = deliver;
    this._pressEnter = pressEnter;
    this._onMessageComplete = onMessageComplete ?? (() => {});
    this._onSegmentError = onSegmentError ?? (() => {});
    this._logger = logger;
    this._queue = Promise.resolve();
    this._cancelled = false;
    this._stopped = false;
    this._message = { parts: [], rawParts: [], incomplete: false };
    this._audio = null;
    // Whether the last pasted phrase was cut while the user kept talking.
    this._midSentence = false;
    this._segmenter = new ContinuousSegmenter({
      ...segmenterOptions,
      submitSilenceMs,
      onSegment: (samples, info) => this._enqueue(() => this._handleSegment(samples, info)),
      onSubmit: () => this._enqueue(() => this._submitMessage({ pressEnter: true })),
    });
  }

  get cancelled() {
    return this._cancelled;
  }

  // Connects the mic stream through the PCM worklet at 16 kHz.
  async attach(stream, workletUrl) {
    const context = new AudioContext({ sampleRate: CONTINUOUS_SAMPLE_RATE });
    // Not awaited: resume() can hang when the output device is wedged.
    if (context.state === "suspended") context.resume().catch(() => {});
    await context.audioWorklet.addModule(workletUrl);
    const source = context.createMediaStreamSource(stream);
    // Mono, like the batch recorder's PCM tap.
    const node = new AudioWorkletNode(context, "pcm-streaming-processor", {
      channelCount: 1,
      channelCountMode: "explicit",
    });
    node.port.onmessage = (event) => {
      if (event.data === "flushed") return;
      this.feed(new Int16Array(event.data));
    };
    source.connect(node);
    this._audio = { context, source, node };
    // Stopped while the worklet loaded.
    if (this._stopped) this._detachAudio();
  }

  feed(frame) {
    if (this._stopped) return;
    this._segmenter.push(frame);
  }

  getLevel() {
    if (this._stopped) return null;
    return this._segmenter.getLevel();
  }

  // Ends capture and resolves once every spoken phrase has been pasted. The
  // last message is pasted but not submitted: stopping is not a pause.
  async stop() {
    if (this._stopped) return this._queue;
    this._stopped = true;
    this._segmenter.flush();
    this._detachAudio();
    this._enqueue(() => this._submitMessage({ pressEnter: false }));
    return this._queue;
  }

  // Ends capture and drops every phrase that hasn't been pasted yet.
  cancel() {
    this._cancelled = true;
    this._stopped = true;
    this._detachAudio();
    this._message = { parts: [], rawParts: [], incomplete: false };
  }

  _detachAudio() {
    const audio = this._audio;
    this._audio = null;
    if (!audio) return;
    audio.node.port.onmessage = null;
    audio.source.disconnect();
    audio.node.disconnect();
    audio.context.close().catch(() => {});
  }

  _enqueue(job) {
    this._queue = this._queue.then(job).catch((error) => {
      this._logger?.error?.("Continuous dictation job failed", { error: error?.message }, "audio");
    });
    return this._queue;
  }

  async _handleSegment(samples, info) {
    try {
      await this._transcribeAndPaste(samples, info);
    } finally {
      // Starts the submit countdown over now that the text is on screen.
      this._segmenter.phraseSettled();
    }
  }

  async _transcribeAndPaste(samples, { durationMs, speechMs, endedAtPause = true }) {
    if (this._cancelled) return;
    const startedAt = Date.now();
    let transcript;
    try {
      transcript = await this._transcribe(buildWav(samples, CONTINUOUS_SAMPLE_RATE), {
        durationSeconds: durationMs / 1000,
      });
    } catch (error) {
      if (this._cancelled) return;
      // A message missing a phrase is never submitted for the user.
      this._message.incomplete = true;
      this._logger?.warn?.(
        "Continuous dictation phrase failed to transcribe",
        { error: error?.message, durationMs, speechMs },
        "audio"
      );
      this._onSegmentError(error);
      return;
    }
    if (this._cancelled) return;
    const heard = withoutSoundTags(transcript?.text ?? "");
    if (!heard) return;
    const text = joinChunk(heard, {
      continuesSentence: this._midSentence,
      endsMidSentence: !endedAtPause,
    });
    this._midSentence = !endedAtPause;
    const outcome = await this._deliver(text);
    if (this._cancelled) return;
    this._message.parts.push(text);
    this._message.rawParts.push(transcript.rawText?.trim() || text);
    if (!outcome?.pasted) this._message.incomplete = true;
    this._logger?.info?.(
      "Continuous dictation phrase pasted",
      {
        pasted: outcome?.pasted === true,
        reason: outcome?.reason ?? null,
        chars: text.length,
        speechMs,
        endedAtPause,
        elapsedMs: Date.now() - startedAt,
      },
      "audio"
    );
  }

  async _submitMessage({ pressEnter }) {
    const message = this._message;
    this._message = { parts: [], rawParts: [], incomplete: false };
    if (this._cancelled || message.parts.length === 0) return;
    let submitted = false;
    if (pressEnter && !message.incomplete) {
      submitted = (await this._pressEnter()) === true;
      this._logger?.info?.(
        "Continuous dictation pressed Enter",
        { pressed: submitted, parts: message.parts.length },
        "audio"
      );
    } else if (pressEnter) {
      this._logger?.info?.(
        "Continuous dictation skipped Enter for an incomplete message",
        { parts: message.parts.length },
        "audio"
      );
    }
    this._onMessageComplete({
      text: message.parts.join(" "),
      rawText: message.rawParts.join(" "),
      submitted,
    });
  }
}
