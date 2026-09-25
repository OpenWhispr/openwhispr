// Pure pieces of voice conversation's end-to-end harness: the scripted scenarios,
// audio shaping, scoring, and the report. The runner (voiceHarnessRunner.js)
// drives them through the live app.

/**
 * Spoken scenarios, played in order within one conversation. `expectTools` is
 * any-of; empty means the model should answer without a tool. Write tools run
 * as dry runs in harness mode, so nothing in the user's data changes.
 */
const HARNESS_SCENARIOS = [
  { id: "calendar-tomorrow", say: "What's on my calendar tomorrow?", expectTools: ["get_calendar_events"] },
  {
    id: "free-thursday",
    say: "When am I free on Thursday afternoon?",
    expectTools: ["get_calendar_availability", "get_calendar_events"],
  },
  { id: "notes-revenue", say: "Find my notes about quarterly revenue.", expectTools: ["search_notes"] },
  {
    id: "note-create",
    say: "Make a note to call the dentist on Friday.",
    expectTools: ["create_note"],
  },
  {
    id: "note-correct",
    say: "Actually, make that Thursday instead.",
    expectTools: ["update_note", "create_note", "search_notes"],
  },
  { id: "dictionary-add", say: "Add Kubernetes to my dictionary.", expectTools: ["update_dictionary"] },
  { id: "clipboard-copy", say: "Copy the words hello world to my clipboard.", expectTools: ["copy_to_clipboard"] },
  { id: "web-artemis", say: "What's the latest news on the Artemis mission?", expectTools: ["web_search"] },
  { id: "snippet-standup", say: "Read back my standup snippet.", expectTools: ["get_snippet"] },
  { id: "plain-rag", say: "Explain what RAG means in one sentence.", expectTools: [] },
  {
    id: "barge-in",
    say: "Tell me about the history of the Roman Empire.",
    expectTools: [],
    bargeIn: { say: "Stop, that's enough, thanks." },
  },
  { id: "plain-capital", say: "What's the capital of Australia?", expectTools: [] },
  { id: "web-weather", say: "What's the weather in Tokyo right now?", expectTools: ["web_search"] },
  { id: "web-news", say: "What's in the news today?", expectTools: ["web_search"] },
  { id: "plain-thanks", say: "Thanks, that's all for now.", expectTools: [] },
];

function resampleLinear(samples, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < out.length; index += 1) {
    const source = index * ratio;
    const left = Math.floor(source);
    const right = left + 1 < samples.length ? samples[left + 1] : samples[left];
    out[index] = samples[left] + (source - left) * (right - samples[left]);
  }
  return out;
}

function toFrames(samples, frameSize = 512) {
  const frames = [];
  for (let start = 0; start < samples.length; start += frameSize) {
    const frame = new Float32Array(frameSize);
    frame.set(samples.subarray(start, Math.min(start + frameSize, samples.length)));
    frames.push(frame);
  }
  return frames;
}

function scoreTurn({ expectTools, calledTools, availableTools }) {
  if (expectTools.length === 0) {
    return calledTools.length === 0
      ? { status: "pass" }
      : { status: "fail", reason: `called ${calledTools.join(", ")} but no tool was needed` };
  }
  if (!expectTools.some((name) => availableTools.includes(name))) {
    return { status: "skipped", reason: `${expectTools.join(" / ")} not available in this session` };
  }
  return expectTools.some((name) => calledTools.includes(name))
    ? { status: "pass" }
    : {
        status: "fail",
        reason: calledTools.length ? `called ${calledTools.join(", ")}` : "answered without a tool",
      };
}

function percentile(values, p) {
  const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function stats(values) {
  return { p50: percentile(values, 50), p90: percentile(values, 90), n: values.filter(Number.isFinite).length };
}

function summarizeHarness(results) {
  const scored = results.map((item) => ({ item, score: scoreTurn(item) }));
  const metric = (key) => results.map((item) => item.metrics?.[key]).filter(Number.isFinite);
  return {
    passed: scored.filter(({ score }) => score.status === "pass").length,
    failed: scored.filter(({ score }) => score.status === "fail").length,
    skipped: scored.filter(({ score }) => score.status === "skipped").length,
    failures: scored.filter(({ score }) => score.status === "fail").map(({ item }) => item.id),
    // The full wait the user feels: turn-end detection, then the pipeline.
    userStop: stats(metric("userStopToFirstAudioMs")),
    endpoint: stats(metric("endpointMs")),
    firstAudio: stats(metric("speechEndToFirstAudioMs")),
    firstWord: stats(metric("transcriptToFirstDeltaMs")),
    ttsFirstAudio: stats(metric("firstChunkToFirstAudioMs")),
    bargeIn: stats(results.map((item) => item.bargeInMs).filter(Number.isFinite)),
  };
}

const seconds = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} s` : "–");
const cell = (text) => String(text ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();

function formatHarnessReport({ results, summary, environment }) {
  const scoredTotal = summary.passed + summary.failed;
  const lines = [
    "# Voice conversation harness report",
    "",
    `- Machine: ${environment.machine}, ${environment.memoryGb} GB`,
    `- Brain: ${environment.brain} · Voice: ${environment.tts} · Run: ${environment.startedAt ?? ""}`,
    "",
    "| Measure | p50 | p90 | n |",
    "| --- | --- | --- | --- |",
    `| You stop talking → first sound | ${seconds(summary.userStop.p50)} | ${seconds(summary.userStop.p90)} | ${summary.userStop.n} |`,
    `| Turn-end detection (speech end → turn committed) | ${seconds(summary.endpoint.p50)} | ${seconds(summary.endpoint.p90)} | ${summary.endpoint.n} |`,
    `| First audio (speech end → first sound) | ${seconds(summary.firstAudio.p50)} | ${seconds(summary.firstAudio.p90)} | ${summary.firstAudio.n} |`,
    `| Model first word (transcript → first token) | ${seconds(summary.firstWord.p50)} | ${seconds(summary.firstWord.p90)} | ${summary.firstWord.n} |`,
    `| TTS first audio | ${seconds(summary.ttsFirstAudio.p50)} | ${seconds(summary.ttsFirstAudio.p90)} | ${summary.ttsFirstAudio.n} |`,
    `| Barge-in (speech start → audio stopped) | ${seconds(summary.bargeIn.p50)} | ${seconds(summary.bargeIn.p90)} | ${summary.bargeIn.n} |`,
    "",
    `Tool choice: **${summary.passed}/${scoredTotal} correct**, ${summary.skipped} skipped (tool not available in this session).`,
    "",
    // "Ran" verifies the write-once guard end to end: "Called" is every tool call
    // the model made (including repeats the guard blocked from running), so
    // e.g. note-create can list "create_note, create_note" under Called while
    // Ran shows the guard only let one of them through.
    "| Scenario | Result | Heard | Expected | Called | Ran | First audio | Answer |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of results) {
    const score = scoreTurn(item);
    lines.push(
      `| ${item.id} | ${score.status}${score.reason ? ` (${cell(score.reason)})` : ""} | ${cell(item.heard)} | ${cell(item.expectTools.join(" / ") || "none")} | ${cell(item.calledTools.join(", ") || "none")} | ${cell((item.ranWrites ?? []).join(", ") || "none")} | ${seconds(item.metrics?.speechEndToFirstAudioMs)} | ${cell((item.answer || "").slice(0, 120))} |`
    );
  }
  return lines.join("\n") + "\n";
}

module.exports = {
  HARNESS_SCENARIOS,
  resampleLinear,
  toFrames,
  scoreTurn,
  percentile,
  summarizeHarness,
  formatHarnessReport,
};
