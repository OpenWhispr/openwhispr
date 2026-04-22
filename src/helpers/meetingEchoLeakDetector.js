const SAMPLE_RATE = 24000;
const MAX_SYSTEM_HISTORY_MS = 6000;
const MAX_MIC_HISTORY_MS = 12000;
const MIN_RMS = 0.006;
const MIN_SYSTEM_RMS = 0.004;
const MAX_LAG_MS = 500;
const LAG_STEP_SAMPLES = 120;
const PARTIAL_WINDOW_MS = 600;
const FINAL_PADDING_MS = 500;
const CHUNK_MUTE_WINDOW_MS = 260;
const STRONG_BLEED_CORRELATION = 0.75;
const STRONG_BLEED_RESIDUAL = 0.32;
const STRONG_BLEED_EXPLAINED = 0.65;
const STRONG_BLEED_MIC_TO_SYSTEM_RATIO = 1.25;
const PARTIAL_BLEED_CORRELATION = 0.6;
const PARTIAL_BLEED_RESIDUAL = 0.45;
const PARTIAL_BLEED_EXPLAINED = 0.5;
const HIGH_CORRELATION_BLEED = 0.7;
const FINAL_BLEED_CORRELATION = 0.55;
const FINAL_BLEED_RESIDUAL = 0.48;
const FINAL_BLEED_EXPLAINED = 0.45;
const FINAL_BLEED_MIC_TO_SYSTEM_RATIO = 1.35;
const SYSTEM_VAD_TAIL_MS = 300;
const VAD_GATED_BLEED_CORRELATION = 0.4;
const VAD_GATED_BLEED_RESIDUAL = 0.6;
const VAD_GATED_BLEED_EXPLAINED = 0.35;
const VAD_GATED_SUSPECTED_SHARE = 0.3;
const DOUBLE_TALK_CORRELATION = 0.45;
const DOUBLE_TALK_EXPLAINED = 0.3;
const DOUBLE_TALK_RESIDUAL = 0.2;
const DOUBLE_TALK_MIC_TO_SYSTEM_RATIO = 1.16;

function pcm16BufferToFloat32(buffer) {
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const output = new Float32Array(input.length);

  for (let i = 0; i < input.length; i += 1) {
    output[i] = input[i] / 32768;
  }

  return output;
}

function computeRms(samples) {
  if (!samples.length) {
    return 0;
  }

  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sumSq += samples[i] * samples[i];
  }

  return Math.sqrt(sumSq / samples.length);
}

class MeetingEchoLeakDetector {
  constructor() {
    this.systemHistory = [];
    this.micHistory = [];
  }

  reset() {
    this.systemHistory = [];
    this.micHistory = [];
  }

  recordSystemChunk(buffer, timestampMs = Date.now()) {
    if (!buffer?.length) {
      return;
    }

    const samples = pcm16BufferToFloat32(buffer);
    if (!samples.length) {
      return;
    }

    this.systemHistory.push({
      timestampMs,
      samples,
      durationMs: (samples.length / SAMPLE_RATE) * 1000,
      rms: computeRms(samples),
    });

    this._trimHistory(timestampMs);
  }

  analyzeMicChunk(buffer, timestampMs = Date.now()) {
    if (!buffer?.length) {
      return null;
    }

    const samples = pcm16BufferToFloat32(buffer);
    if (!samples.length) {
      return null;
    }

    const rms = computeRms(samples);
    const analysis = {
      timestampMs,
      durationMs: (samples.length / SAMPLE_RATE) * 1000,
      rms,
      correlation: 0,
      residualRatio: 1,
      explainedRatio: 0,
      systemRms: 0,
      micToSystemRatio: null,
      state: "clean_local",
      shouldMute: false,
    };

    if (rms < MIN_RMS) {
      this.micHistory.push(analysis);
      this._trimHistory(timestampMs);
      return analysis;
    }

    const systemWindow = this._getSystemWindow();
    if (systemWindow.length < samples.length + this._maxLagSamples()) {
      analysis.state = "awaiting_reference";
      this.micHistory.push(analysis);
      this._trimHistory(timestampMs);
      return analysis;
    }

    const energyMic = this._computeEnergy(samples);
    let bestCorr = 0;
    let bestResidualRatio = 1;
    let bestExplainedRatio = 0;
    let bestSystemRms = 0;

    for (let lag = 0; lag <= this._maxLagSamples(); lag += LAG_STEP_SAMPLES) {
      const start = systemWindow.length - samples.length - lag;
      if (start < 0) {
        break;
      }

      const candidate = systemWindow.subarray(start, start + samples.length);
      const energySystem = this._computeEnergy(candidate);
      if (energySystem <= 0) {
        continue;
      }

      let dot = 0;
      for (let i = 0; i < samples.length; i += 1) {
        dot += samples[i] * candidate[i];
      }

      const corr = dot / Math.sqrt(energyMic * energySystem);
      if (corr <= bestCorr) {
        continue;
      }

      const alpha = dot / energySystem;
      let residualEnergy = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const residual = samples[i] - alpha * candidate[i];
        residualEnergy += residual * residual;
      }

      const explainedRatio = Math.max(0, Math.min(1, 1 - residualEnergy / energyMic));
      bestCorr = corr;
      bestResidualRatio = residualEnergy / energyMic;
      bestExplainedRatio = explainedRatio;
      bestSystemRms = Math.sqrt(energySystem / candidate.length);
    }

    analysis.correlation = bestCorr;
    analysis.residualRatio = bestResidualRatio;
    analysis.explainedRatio = bestExplainedRatio;
    analysis.systemRms = bestSystemRms;
    analysis.micToSystemRatio = bestSystemRms > 0 ? rms / bestSystemRms : null;
    analysis.state = this._resolveState(analysis);

    this.micHistory.push(analysis);
    this._trimHistory(timestampMs);
    analysis.shouldMute = this.shouldMuteMicChunk(analysis, timestampMs);
    return analysis;
  }

  isMicProbablyRenderBleed(nowMs = Date.now()) {
    const recent = this.micHistory.filter(
      (entry) =>
        nowMs - entry.timestampMs <= PARTIAL_WINDOW_MS &&
        entry.rms >= MIN_RMS &&
        entry.state !== "awaiting_reference"
    );

    if (recent.length < 3) {
      return false;
    }

    const bleedMatches = recent.filter((entry) =>
      this._matchesBleedProfile(
        entry,
        PARTIAL_BLEED_CORRELATION,
        PARTIAL_BLEED_RESIDUAL,
        PARTIAL_BLEED_EXPLAINED
      )
    );
    if (bleedMatches.length < Math.ceil(recent.length * 0.8)) {
      return false;
    }

    const averageCorrelation =
      bleedMatches.reduce((sum, entry) => sum + entry.correlation, 0) / bleedMatches.length;
    const averageResidual =
      bleedMatches.reduce((sum, entry) => sum + entry.residualRatio, 0) / bleedMatches.length;
    const averageExplained =
      bleedMatches.reduce((sum, entry) => sum + entry.explainedRatio, 0) / bleedMatches.length;

    return (
      averageCorrelation >= HIGH_CORRELATION_BLEED ||
      (averageCorrelation >= PARTIAL_BLEED_CORRELATION &&
        averageResidual <= PARTIAL_BLEED_RESIDUAL &&
        averageExplained >= PARTIAL_BLEED_EXPLAINED)
    );
  }

  isSystemSpeaking(windowStartMs, windowEndMs = Date.now()) {
    for (let i = this.systemHistory.length - 1; i >= 0; i -= 1) {
      const entry = this.systemHistory[i];
      const entryEnd = entry.timestampMs + entry.durationMs;
      if (entryEnd < windowStartMs - SYSTEM_VAD_TAIL_MS) {
        break;
      }
      if (entry.rms >= MIN_SYSTEM_RMS && entry.timestampMs <= windowEndMs + SYSTEM_VAD_TAIL_MS) {
        return true;
      }
    }
    return false;
  }

  shouldSuppressMicSegment(startedAtMs, endedAtMs = Date.now()) {
    if (!startedAtMs) {
      return { suppress: false, reason: "missing_start" };
    }

    const windowStart = startedAtMs - FINAL_PADDING_MS;
    const windowEnd = endedAtMs + FINAL_PADDING_MS;
    const systemSpeaking = this.isSystemSpeaking(startedAtMs, endedAtMs);
    const relevant = this.micHistory.filter(
      (entry) =>
        entry.timestampMs + entry.durationMs >= windowStart &&
        entry.timestampMs <= windowEnd &&
        entry.state !== "awaiting_reference"
    );

    if (relevant.length < 2) {
      return { suppress: false, reason: "insufficient_signal" };
    }

    const doubleTalk = relevant.filter((entry) => entry.state === "double_talk");
    const bleedMatches = relevant.filter((entry) =>
      this._matchesBleedProfile(
        entry,
        FINAL_BLEED_CORRELATION,
        FINAL_BLEED_RESIDUAL,
        FINAL_BLEED_EXPLAINED
      )
    );

    const averageCorrelation =
      bleedMatches.length > 0
        ? bleedMatches.reduce((sum, entry) => sum + entry.correlation, 0) / bleedMatches.length
        : 0;
    const averageResidual =
      bleedMatches.length > 0
        ? bleedMatches.reduce((sum, entry) => sum + entry.residualRatio, 0) / bleedMatches.length
        : 1;
    const averageExplained =
      bleedMatches.length > 0
        ? bleedMatches.reduce((sum, entry) => sum + entry.explainedRatio, 0) / bleedMatches.length
        : 0;
    const averageMicToSystemRatio =
      bleedMatches.length > 0
        ? bleedMatches.reduce((sum, entry) => sum + (entry.micToSystemRatio || 0), 0) /
          bleedMatches.length
        : null;
    const hasBleedEvidence =
      bleedMatches.length > 0 &&
      (averageCorrelation >= HIGH_CORRELATION_BLEED ||
        (averageCorrelation >= PARTIAL_BLEED_CORRELATION &&
          averageResidual <= PARTIAL_BLEED_RESIDUAL &&
          averageExplained >= PARTIAL_BLEED_EXPLAINED));
    const bleedShare = bleedMatches.length / relevant.length;
    const shareGate = systemSpeaking ? VAD_GATED_SUSPECTED_SHARE : 0.6;
    const likelyRenderBleedShareGate = systemSpeaking ? VAD_GATED_SUSPECTED_SHARE : 0.4;
    const likelyRenderBleed = hasBleedEvidence && bleedShare >= likelyRenderBleedShareGate;

    if (doubleTalk.length > 0 && !likelyRenderBleed) {
      return {
        suppress: false,
        reason: "double_talk",
        hasBleedEvidence,
        likelyRenderBleed,
        averageCorrelation,
        averageResidual,
        averageExplained,
        averageMicToSystemRatio,
        bleedMatchCount: bleedMatches.length,
        sampleCount: relevant.length,
        systemSpeaking,
      };
    }

    if (bleedShare < shareGate) {
      return {
        suppress: false,
        reason: "mixed_signal",
        hasBleedEvidence,
        likelyRenderBleed,
        averageCorrelation,
        averageResidual,
        averageExplained,
        averageMicToSystemRatio,
        bleedMatchCount: bleedMatches.length,
        sampleCount: relevant.length,
        systemSpeaking,
      };
    }

    const corrGate = systemSpeaking ? VAD_GATED_BLEED_CORRELATION : FINAL_BLEED_CORRELATION;
    const residualGate = systemSpeaking ? VAD_GATED_BLEED_RESIDUAL : FINAL_BLEED_RESIDUAL;
    const explainedGate = systemSpeaking ? VAD_GATED_BLEED_EXPLAINED : FINAL_BLEED_EXPLAINED;

    const suppress =
      doubleTalk.length === 0 &&
      averageCorrelation >= corrGate &&
      averageResidual <= residualGate &&
      averageExplained >= explainedGate &&
      (averageMicToSystemRatio == null ||
        averageMicToSystemRatio <= FINAL_BLEED_MIC_TO_SYSTEM_RATIO);

    return {
      suppress,
      hasBleedEvidence,
      likelyRenderBleed,
      systemSpeaking,
      reason: suppress ? "render_bleed" : doubleTalk.length > 0 ? "mixed_signal" : "weak_match",
      averageCorrelation,
      averageResidual,
      averageExplained,
      averageMicToSystemRatio,
      bleedMatchCount: bleedMatches.length,
      sampleCount: relevant.length,
    };
  }

  shouldMuteMicChunk(analysis, nowMs = Date.now()) {
    if (!analysis || analysis.state !== "suspected_render_bleed") {
      return false;
    }

    const recent = this.micHistory.filter(
      (entry) => nowMs - entry.timestampMs <= CHUNK_MUTE_WINDOW_MS && entry.rms >= MIN_RMS
    );

    if (recent.some((entry) => entry.state === "double_talk")) {
      return false;
    }

    return (
      analysis.correlation >= STRONG_BLEED_CORRELATION &&
      analysis.residualRatio <= STRONG_BLEED_RESIDUAL &&
      analysis.explainedRatio >= STRONG_BLEED_EXPLAINED &&
      (analysis.micToSystemRatio == null ||
        analysis.micToSystemRatio <= STRONG_BLEED_MIC_TO_SYSTEM_RATIO)
    );
  }

  _resolveState(analysis) {
    const { correlation, residualRatio, explainedRatio, rms, systemRms, micToSystemRatio } =
      analysis;

    if (rms < MIN_RMS || systemRms < MIN_SYSTEM_RMS) {
      return "clean_local";
    }

    if (
      correlation >= 0.6 &&
      residualRatio <= 0.45 &&
      explainedRatio >= 0.5 &&
      (micToSystemRatio == null || micToSystemRatio <= 1.3)
    ) {
      return "suspected_render_bleed";
    }

    if (
      correlation >= DOUBLE_TALK_CORRELATION &&
      explainedRatio >= DOUBLE_TALK_EXPLAINED &&
      (residualRatio >= DOUBLE_TALK_RESIDUAL ||
        (micToSystemRatio != null && micToSystemRatio >= DOUBLE_TALK_MIC_TO_SYSTEM_RATIO))
    ) {
      return "double_talk";
    }

    return "clean_local";
  }

  _trimHistory(nowMs) {
    const systemCutoff = nowMs - MAX_SYSTEM_HISTORY_MS;
    const micCutoff = nowMs - MAX_MIC_HISTORY_MS;

    while (this.systemHistory.length > 0 && this.systemHistory[0].timestampMs < systemCutoff) {
      this.systemHistory.shift();
    }

    while (this.micHistory.length > 0 && this.micHistory[0].timestampMs < micCutoff) {
      this.micHistory.shift();
    }
  }

  _getSystemWindow() {
    const totalLength = this.systemHistory.reduce((sum, entry) => sum + entry.samples.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;

    for (const entry of this.systemHistory) {
      merged.set(entry.samples, offset);
      offset += entry.samples.length;
    }

    return merged;
  }

  _computeEnergy(samples) {
    let sumSq = 0;
    for (let i = 0; i < samples.length; i += 1) {
      sumSq += samples[i] * samples[i];
    }
    return sumSq;
  }

  _matchesBleedProfile(entry, correlationGate, residualGate, explainedGate) {
    return (
      !!entry &&
      entry.rms >= MIN_RMS &&
      entry.systemRms >= MIN_SYSTEM_RMS &&
      entry.correlation >= correlationGate &&
      entry.residualRatio <= residualGate &&
      entry.explainedRatio >= explainedGate
    );
  }

  _maxLagSamples() {
    return Math.round((MAX_LAG_MS / 1000) * SAMPLE_RATE);
  }
}

module.exports = MeetingEchoLeakDetector;
