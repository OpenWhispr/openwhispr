const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");

const FRAME_SHIFT_SAMPLES = 270;
const MIN_SEGMENT_DURATION = 0.2;

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function buildSimilarityMatrix(embeddings) {
  const n = embeddings.length;
  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      matrix[i][j] = sim;
      matrix[j][i] = sim;
    }
  }
  return matrix;
}

function clusterEmbeddings(embeddings, { numSpeakers = -1, threshold = 0.55 } = {}) {
  if (embeddings.length === 0) return [];
  if (embeddings.length === 1) return [0];

  const n = embeddings.length;
  const simMatrix = buildSimilarityMatrix(embeddings);

  const labels = Array.from({ length: n }, (_, i) => i);
  const clusters = Array.from({ length: n }, (_, i) => [i]);
  let numClusters = n;

  const useFixedCount = numSpeakers > 0;

  while (numClusters > 1) {
    let maxSim = -Infinity;
    let mergeA = -1, mergeB = -1;

    for (let i = 0; i < n; i++) {
      if (clusters[i] === null) continue;
      for (let j = i + 1; j < n; j++) {
        if (clusters[j] === null) continue;

        let avgSim = 0;
        let count = 0;
        for (const a of clusters[i]) {
          for (const b of clusters[j]) {
            avgSim += simMatrix[a][b];
            count++;
          }
        }
        avgSim /= count;

        if (avgSim > maxSim) {
          maxSim = avgSim;
          mergeA = i;
          mergeB = j;
        }
      }
    }

    if (useFixedCount && numClusters <= numSpeakers) break;
    if (!useFixedCount && maxSim < threshold) break;

    for (const idx of clusters[mergeB]) {
      labels[idx] = mergeA;
      clusters[mergeA].push(idx);
    }
    clusters[mergeB] = null;
    numClusters--;
  }

  const uniqueLabels = [...new Set(labels)].sort((a, b) => a - b);
  const labelMap = new Map(uniqueLabels.map((l, i) => [l, i]));
  return labels.map((l) => labelMap.get(l));
}

const POWERSET_CLASSES = [
  [],        // class 0: non-speech
  [0],       // class 1: speaker 0
  [1],       // class 2: speaker 1
  [2],       // class 3: speaker 2
  [0, 1],    // class 4: speakers 0+1
  [0, 2],    // class 5: speakers 0+2
  [1, 2],    // class 6: speakers 1+2
];

function softmax(logits, numClasses) {
  let maxVal = -Infinity;
  for (let i = 0; i < numClasses; i++) {
    if (logits[i] > maxVal) maxVal = logits[i];
  }
  let sum = 0;
  const probs = new Float64Array(numClasses);
  for (let i = 0; i < numClasses; i++) {
    probs[i] = Math.exp(logits[i] - maxVal);
    sum += probs[i];
  }
  for (let i = 0; i < numClasses; i++) probs[i] /= sum;
  return probs;
}

function buildSegmentsFromWindows(windows, sampleRate) {
  if (windows.length === 0) return [];

  const segments = [];
  const frameShiftSec = FRAME_SHIFT_SAMPLES / sampleRate;

  for (const win of windows) {
    const [, numFrames, numClasses] = win.dims;
    const offsetSec = win.offset / sampleRate;

    for (let f = 0; f < numFrames; f++) {
      const logits = [];
      for (let c = 0; c < numClasses; c++) {
        logits.push(win.data[f * numClasses + c]);
      }

      const probs = softmax(logits, numClasses);

      let bestClass = 0;
      let bestProb = probs[0];
      for (let c = 1; c < numClasses; c++) {
        if (probs[c] > bestProb) {
          bestProb = probs[c];
          bestClass = c;
        }
      }

      if (bestClass === 0) continue;

      const speakers = POWERSET_CLASSES[bestClass] || [bestClass - 1];
      const speakerIdx = speakers[0];

      const start = offsetSec + f * frameShiftSec;
      const end = start + frameShiftSec;
      const prev = segments[segments.length - 1];

      if (prev && prev.speakerIdx === speakerIdx && Math.abs(start - prev.end) < frameShiftSec * 1.5) {
        prev.end = end;
      } else {
        segments.push({ start, end, speakerIdx });
      }
    }
  }

  return segments.filter((s) => s.end - s.start >= MIN_SEGMENT_DURATION);
}

function readAudioAsPcm(filePath) {
  const { getFFmpegPath } = require("./ffmpegUtils");
  const ffmpegPath = getFFmpegPath();
  if (!ffmpegPath) throw new Error("FFmpeg not found");

  return new Promise((resolve, reject) => {
    const args = [
      "-i", filePath,
      "-ar", "16000",
      "-ac", "1",
      "-f", "f32le",
      "-acodec", "pcm_f32le",
      "pipe:1",
    ];

    const proc = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const chunks = [];
    proc.stdout.on("data", (chunk) => chunks.push(chunk));

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg PCM extraction failed (code ${code})`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      resolve(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4));
    });

    proc.on("error", reject);
  });
}

const SEGMENTATION_DIR = "sherpa-onnx-pyannote-segmentation-3-0";
const SEGMENTATION_ONNX = path.join(SEGMENTATION_DIR, "model.onnx");
const EMBEDDING_ONNX = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
const EMBED_BATCH_SIZE = 32;

async function gpuDiarize(filePath, onnxWorkerClient, diarizationManager, options = {}) {
  const { numSpeakers = -1, threshold = 0.55 } = options;
  const startTime = performance.now();

  debugLogger.info("[diarization] Starting GPU pipeline", { filePath, numSpeakers });

  const segModelPath = diarizationManager._resolveModelPath(SEGMENTATION_ONNX);
  const embModelPath = diarizationManager._resolveModelPath(EMBEDDING_ONNX);

  if (!segModelPath || !embModelPath) {
    debugLogger.warn("[diarization] Models not found, cannot use GPU pipeline");
    return null;
  }

  if (!fs.existsSync(segModelPath) || !fs.existsSync(embModelPath)) {
    debugLogger.warn("[diarization] Model files missing on disk");
    return null;
  }

  const loadStart = performance.now();
  await onnxWorkerClient.diarizeLoad(segModelPath, embModelPath);
  debugLogger.info("[diarization] Models loaded", {
    elapsed: Math.round(performance.now() - loadStart),
  });

  const pcmStart = performance.now();
  const samples = await readAudioAsPcm(filePath);
  const audioDuration = samples.length / 16000;
  debugLogger.info("[diarization] Audio read as PCM", {
    samples: samples.length,
    durationSec: Math.round(audioDuration),
    elapsed: Math.round(performance.now() - pcmStart),
  });

  const segStart = performance.now();
  const transferBuffer = samples.buffer.slice(
    samples.byteOffset, samples.byteOffset + samples.byteLength
  );
  const { windows } = await onnxWorkerClient.diarizeSegment(transferBuffer, 16000);
  debugLogger.info("[diarization] Segmentation complete", {
    windows: windows.length,
    elapsed: Math.round(performance.now() - segStart),
  });

  const rawSegments = buildSegmentsFromWindows(windows, 16000);
  debugLogger.info("[diarization] Segments built", { count: rawSegments.length });

  if (rawSegments.length === 0) {
    debugLogger.warn("[diarization] No speech segments found");
    return [];
  }

  // Fast path: use segmentation speaker indices directly (no embeddings)
  // The powerset model assigns local speaker IDs per window. With 50% overlap,
  // adjacent windows produce consistent assignments for 2-3 speaker conversations.
  const merged = [];
  for (const seg of rawSegments) {
    const prev = merged[merged.length - 1];
    const speaker = `speaker_${seg.speakerIdx}`;
    if (prev && prev.speaker === speaker && seg.start - prev.end < 1.0) {
      prev.end = seg.end;
    } else {
      merged.push({ start: seg.start, end: seg.end, speaker });
    }
  }

  const totalElapsed = Math.round(performance.now() - startTime);
  const speakerCount = new Set(merged.map((s) => s.speaker)).size;
  debugLogger.info("[diarization] GPU pipeline complete (fast path)", {
    speakers: speakerCount,
    segments: merged.length,
    audioDurationSec: Math.round(audioDuration),
    totalElapsedMs: totalElapsed,
    rtf: (totalElapsed / 1000 / audioDuration).toFixed(4),
  });

  return merged;
}

module.exports = {
  gpuDiarize,
  cosineSimilarity,
  buildSimilarityMatrix,
  clusterEmbeddings,
  buildSegmentsFromWindows,
  readAudioAsPcm,
};
