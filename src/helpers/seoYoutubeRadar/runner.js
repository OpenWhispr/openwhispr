const {
  buildSearchQueries,
  buildLocalRelevancePrompt,
  dedupeCandidates,
  normalizeRadarConfig,
  scoreVideoCandidate,
} = require("./scoring");

const MIN_RELEVANCE_SCORE = 70;

function parseLocalJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  const text = String(value).trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function buildEnhancedContent({ video, transcript, summary, keyTakeaways = [], score }) {
  const takeawayLines = Array.isArray(keyTakeaways)
    ? keyTakeaways.filter(Boolean).map((item) => `- ${item}`)
    : [];
  return [
    "## Summary",
    "",
    summary || "Summary generation failed. Full transcript is still available below.",
    "",
    "## Key Takeaways",
    "",
    takeawayLines.length > 0 ? takeawayLines.join("\n") : "- No key takeaways generated.",
    "",
    "## Source",
    "",
    `- Video: [${video.title || "YouTube video"}](${video.url})`,
    `- Channel: ${video.channelTitle || "Unknown"}`,
    `- Score: ${score?.score ?? 0}`,
    "",
    "## Full Transcript",
    "",
    transcript,
  ].join("\n");
}

function toNoteTitle(video) {
  const title = String(video.title || "SEO YouTube video").trim();
  return title.length > 120 ? `${title.slice(0, 117)}...` : title;
}

async function classifyVideo({ video, classifyLocal, summarizeLocal }) {
  const prompt = buildLocalRelevancePrompt(video);
  const classifier = classifyLocal || ((candidate) => summarizeLocal(candidate, "", { prompt }));
  const result = await classifier(video, prompt);
  return parseLocalJson(result);
}

async function summarizeTranscript({ video, transcript, summarizeLocal }) {
  const result = await summarizeLocal(video, transcript);
  return parseLocalJson(result);
}

async function runSeoYoutubeRadar({
  config,
  store,
  youtubeClient,
  importAudio,
  transcribeAudio,
  classifyLocal,
  summarizeLocal,
  saveNote,
  nowMs = Date.now(),
}) {
  const normalizedConfig = normalizeRadarConfig(config);
  const result = {
    processed: 0,
    rejected: 0,
    skipped: 0,
    errors: [],
    candidates: 0,
  };

  const publishedAfter = new Date(nowMs - normalizedConfig.lookbackHours * 3_600_000).toISOString();
  const searchResults = [];
  for (const query of buildSearchQueries(normalizedConfig)) {
    const matches = await youtubeClient.searchVideos({
      query,
      publishedAfter,
      maxResults: normalizedConfig.maxSearchResultsPerQuery,
      regionCode: normalizedConfig.regionCode,
      language: normalizedConfig.language,
    });
    searchResults.push(...matches);
  }

  const searchIds = dedupeCandidates(searchResults).map((candidate) => candidate.id);
  const details = await youtubeClient.getVideoDetails(searchIds);
  const candidates = dedupeCandidates(details)
    .filter((video) => !store.hasProcessed(video.id))
    .filter((video) => !normalizedConfig.excludeShorts || video.durationSeconds >= 60)
    .filter((video) => video.durationSeconds >= normalizedConfig.minDurationSeconds)
    .map((video) => ({ video, score: scoreVideoCandidate(video, nowMs) }))
    .sort((a, b) => b.score.score - a.score.score)
    .slice(0, normalizedConfig.maxVideosToProcess);

  result.candidates = candidates.length;

  for (const { video, score } of candidates) {
    try {
      const classification = await classifyVideo({ video, classifyLocal, summarizeLocal });
      const relevanceScore = Number(classification.relevanceScore || 0);
      if (classification.reject === true || relevanceScore < MIN_RELEVANCE_SCORE) {
        result.rejected++;
        store.markVideo(video.id, "rejected", {
          title: video.title,
          reason: classification.reason || "Low relevance",
          relevanceScore,
        });
        continue;
      }

      const importResult = await importAudio(video.url);
      if (!importResult?.success || !importResult.audioPath) {
        throw new Error(importResult?.error || "YouTube audio import failed");
      }

      const transcriptResult = await transcribeAudio(importResult.audioPath, video);
      if (!transcriptResult?.success || !transcriptResult.text) {
        throw new Error(transcriptResult?.error || "Transcription failed");
      }

      const transcript = transcriptResult.text.trim();
      let summaryResult = {};
      try {
        summaryResult = await summarizeTranscript({ video, transcript, summarizeLocal });
      } catch (error) {
        result.errors.push({ videoId: video.id, stage: "summary", error: error.message });
      }

      const enhancedContent = buildEnhancedContent({
        video,
        transcript,
        summary: summaryResult.summary,
        keyTakeaways: summaryResult.keyTakeaways,
        score,
      });
      const noteResult = await saveNote({
        title: toNoteTitle(video),
        content: transcript,
        enhancedContent,
        sourceFile: video.url,
        video,
        score,
      });
      if (noteResult?.success === false) {
        throw new Error(noteResult.error || "Failed to save note");
      }

      result.processed++;
      store.markVideo(video.id, "processed", {
        title: video.title,
        channelTitle: video.channelTitle,
        noteId: noteResult?.note?.id || null,
        relevanceScore,
        score: score.score,
      });
    } catch (error) {
      result.errors.push({ videoId: video.id, stage: "process", error: error.message });
      store.markVideo(video.id, "seen", { title: video.title, error: error.message });
    }
  }

  result.skipped = Math.max(0, searchIds.length - result.candidates - result.rejected);
  store.appendRun?.({ ...result, createdAt: new Date(nowMs).toISOString() });
  return result;
}

module.exports = {
  MIN_RELEVANCE_SCORE,
  buildEnhancedContent,
  parseLocalJson,
  runSeoYoutubeRadar,
};
