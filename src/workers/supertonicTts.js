// Supertonic 3 text-to-speech on ONNX Runtime: duration, text encoder, flow-matching steps and
// vocoder, as in Supertonic's sample code (MIT, Copyright 2025 Supertone Inc.) and sherpa-onnx's
// port of it (Apache-2.0, Copyright 2026 zengyw).
const fs = require("fs");
const { chunkText, textToIds } = require("./supertonicText");

const CHUNK_SILENCE_SECONDS = 0.3;
const MIN_DURATION_SECONDS = 0.1;
const VOICE_HEADER_BYTES = 48;

/** voice.bin: six int64 dimensions, then every speaker's text style and duration style. */
function parseVoiceStyles(file) {
  const dims = Array.from({ length: 6 }, (_, index) => Number(file.readBigInt64LE(index * 8)));
  const [speakers, ttlRows, ttlColumns, , dpRows, dpColumns] = dims;
  const floats = new Float32Array(
    file.buffer.slice(file.byteOffset + VOICE_HEADER_BYTES, file.byteOffset + file.length)
  );
  const ttlSize = ttlRows * ttlColumns;
  const dpSize = dpRows * dpColumns;
  return {
    speakers,
    ttlShape: [1, ttlRows, ttlColumns],
    dpShape: [1, dpRows, dpColumns],
    ttl: (sid) => floats.slice(sid * ttlSize, (sid + 1) * ttlSize),
    dp: (sid) => {
      const start = speakers * ttlSize + sid * dpSize;
      return floats.slice(start, start + dpSize);
    },
  };
}

function gaussianNoise(length) {
  const noise = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const radius = Math.sqrt(-2 * Math.log(1 - Math.random()));
    noise[index] = radius * Math.cos(2 * Math.PI * Math.random());
  }
  return noise;
}

function joinWithSilence(parts, silenceSamples) {
  const gaps = Math.max(0, parts.length - 1) * silenceSamples;
  const joined = new Float32Array(parts.reduce((sum, part) => sum + part.length, gaps));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length + silenceSamples;
  }
  return joined;
}

async function createSupertonicTts({ ort, sessionOptions, paths, numThreads }) {
  const options = sessionOptions(numThreads);
  const load = (file) => ort.InferenceSession.create(file, options);
  const durationPredictor = await load(paths.durationPredictor);
  const textEncoder = await load(paths.textEncoder);
  const vectorEstimator = await load(paths.vectorEstimator);
  const vocoder = await load(paths.vocoder);

  const { ae, ttl } = JSON.parse(fs.readFileSync(paths.ttsJson, "utf8"));
  const sampleRate = ae.sample_rate;
  const samplesPerLatent = ae.base_chunk_size * ttl.chunk_compress_factor;
  const latentChannels = ttl.latent_dim * ttl.chunk_compress_factor;
  const indexerFile = fs.readFileSync(paths.unicodeIndexer);
  const indexer = new Int32Array(
    indexerFile.buffer.slice(indexerFile.byteOffset, indexerFile.byteOffset + indexerFile.length)
  );
  const styles = parseVoiceStyles(fs.readFileSync(paths.voiceStyle));
  const float32 = (data, dims) => new ort.Tensor("float32", data, dims);

  async function synthesizeChunk(text, { sid, speed, lang, numSteps, isCancelled }) {
    const ids = textToIds(text, lang, indexer);
    const textIds = new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]);
    const textMask = float32(new Float32Array(ids.length).fill(1), [1, 1, ids.length]);
    const styleTtl = float32(styles.ttl(sid), styles.ttlShape);

    const { duration } = await durationPredictor.run({
      text_ids: textIds,
      style_dp: float32(styles.dp(sid), styles.dpShape),
      text_mask: textMask,
    });
    let seconds = duration.data[0];
    if (speed !== 1) seconds = Math.max(MIN_DURATION_SECONDS, Math.fround(seconds / speed));
    const { text_emb: textEmbedding } = await textEncoder.run({
      text_ids: textIds,
      style_ttl: styleTtl,
      text_mask: textMask,
    });

    const wavLength = Math.max(1, Math.trunc(Math.fround(seconds * sampleRate)));
    const latentLength = Math.floor((wavLength + samplesPerLatent - 1) / samplesPerLatent);
    const latentDims = [1, latentChannels, latentLength];
    const latentMask = float32(new Float32Array(latentLength).fill(1), [1, 1, latentLength]);
    const totalStep = float32(new Float32Array([numSteps]), [1]);
    let latent = gaussianNoise(latentChannels * latentLength);
    for (let step = 0; step < numSteps; step += 1) {
      if (isCancelled()) return null;
      const { denoised_latent: denoised } = await vectorEstimator.run({
        noisy_latent: float32(latent, latentDims),
        text_emb: textEmbedding,
        style_ttl: styleTtl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: float32(new Float32Array([step]), [1]),
        total_step: totalStep,
      });
      latent = Float32Array.from(denoised.data);
    }
    if (isCancelled()) return null;
    const { wav_tts: wav } = await vocoder.run({ latent: float32(latent, latentDims) });
    return wav.data.slice(0, Math.min(wavLength, wav.data.length));
  }

  /**
   * Speaks text chunk by chunk: `onChunk` gets each chunk as it is ready, and the result is
   * the whole clip with a short silence between chunks. A cancel stops at the next step.
   */
  async function generate(
    text,
    { sid, speed, lang, numSteps, isCancelled = () => false, onChunk }
  ) {
    const maxChars = lang === "ko" || lang === "ja" ? 120 : 300;
    const speaker = sid >= 0 && sid < styles.speakers ? sid : 0;
    const parts = [];
    for (const chunk of chunkText(text, maxChars)) {
      if (isCancelled()) break;
      const samples = await synthesizeChunk(chunk, {
        sid: speaker,
        speed,
        lang,
        numSteps,
        isCancelled,
      });
      if (!samples) break;
      onChunk?.(samples);
      parts.push(samples);
    }
    return {
      samples: joinWithSilence(parts, Math.trunc(CHUNK_SILENCE_SECONDS * sampleRate)),
      sampleRate,
    };
  }

  return { sampleRate, generate };
}

module.exports = { createSupertonicTts };
