const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  AUDIO_MIME_TYPES,
  providerContentType,
  prepareProviderUpload,
} = require("../../src/helpers/providerUploadAudio");
const { convertToWav, getFFmpegPath } = require("../../src/helpers/ffmpegUtils");
const { UPLOAD_AUDIO_EXTENSIONS } = require("../../src/constants/uploadAudioFormats.json");

// CI installs with --ignore-scripts, so ffmpeg-static's binary may be absent;
// getFFmpegPath falls back to a system ffmpeg when one is on PATH.
const ffmpegPath = getFFmpegPath();
const withoutFfmpeg = !ffmpegPath && "no ffmpeg binary available";

const FIXTURE_SECONDS = 1;
const PCM16_MONO_16K_BYTES_PER_SECOND = 32000;

// Encoder + muxer that produce a genuine file of each container. AMR and APE
// have decoders but no encoder in ffmpeg-static, so they cannot be fixtured.
const ENCODERS = {
  mpeg: ["-c:a", "mp2", "-f", "mpeg"],
  mpg: ["-c:a", "mp2", "-f", "mpeg"],
  mpga: ["-c:a", "libmp3lame", "-f", "mp3"],
  mp2: ["-c:a", "mp2", "-f", "mp2"],
  mp4: ["-c:a", "aac", "-f", "mp4"],
  m4v: ["-c:a", "aac", "-f", "mp4"],
  m4b: ["-c:a", "aac", "-f", "mp4"],
  mov: ["-c:a", "aac", "-f", "mov"],
  mkv: ["-c:a", "aac", "-f", "matroska"],
  mka: ["-c:a", "aac", "-f", "matroska"],
  "3gp": ["-c:a", "aac", "-f", "3gp"],
  avi: ["-c:a", "libmp3lame", "-f", "avi"],
  wmv: ["-c:a", "wmav2", "-f", "asf"],
  wma: ["-c:a", "wmav2", "-f", "asf"],
  aiff: ["-c:a", "pcm_s16be", "-f", "aiff"],
  aif: ["-c:a", "pcm_s16be", "-f", "aiff"],
  aifc: ["-c:a", "pcm_s16be", "-f", "aiff"],
  caf: ["-c:a", "pcm_s16le", "-f", "caf"],
  ac3: ["-c:a", "ac3", "-f", "ac3"],
  au: ["-c:a", "pcm_s16be", "-f", "au"],
  snd: ["-c:a", "pcm_s16be", "-f", "au"],
  wv: ["-c:a", "wavpack", "-f", "wv"],
};
const UNFIXTURABLE = ["amr", "ape"];

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-provider-upload-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFixture(dir, ext, encoderArgs, extraInputs = []) {
  const file = path.join(dir, `fixture.${ext}`);
  execFileSync(ffmpegPath, [
    "-loglevel",
    "error",
    ...extraInputs,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${FIXTURE_SECONDS}`,
    ...encoderArgs,
    "-y",
    file,
  ]);
  return file;
}

function isMp3(buffer) {
  const id3 = buffer.subarray(0, 3).toString() === "ID3";
  const frameSync = buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
  return id3 || frameSync;
}

async function decodedSeconds(mp3Path, dir) {
  const wavPath = path.join(dir, `${path.basename(mp3Path)}.wav`);
  await convertToWav(mp3Path, wavPath, { sampleRate: 16000, channels: 1 });
  return (fs.statSync(wavPath).size - 44) / PCM16_MONO_16K_BYTES_PER_SECOND;
}

test("the fixture matrix covers every picker extension the providers do not take natively", () => {
  const transcoded = UPLOAD_AUDIO_EXTENSIONS.filter((ext) => !(ext in AUDIO_MIME_TYPES));
  assert.deepEqual(
    transcoded.filter((ext) => !(ext in ENCODERS)),
    UNFIXTURABLE
  );
  for (const ext of Object.keys(AUDIO_MIME_TYPES)) {
    assert.ok(UPLOAD_AUDIO_EXTENSIONS.includes(ext), `${ext} must stay pickable`);
  }
});

test("provider-native containers upload as-is with their real content type", async (t) => {
  const dir = makeTempDir(t);
  for (const [ext, mime] of Object.entries(AUDIO_MIME_TYPES)) {
    const file = path.join(dir, `recording.${ext.toUpperCase()}`);
    fs.writeFileSync(file, "not inspected");
    const upload = await prepareProviderUpload(file);
    assert.equal(upload.path, file, ext);
    assert.equal(providerContentType(upload.path), mime, ext);
    upload.cleanup();
    assert.ok(fs.existsSync(file), `${ext} cleanup must not touch the user's file`);
  }
});

test(
  "every other picker extension is re-encoded to a mono MP3 the providers accept",
  { skip: withoutFfmpeg },
  async (t) => {
    const dir = makeTempDir(t);
    for (const [ext, encoderArgs] of Object.entries(ENCODERS)) {
      const source = writeFixture(dir, ext, encoderArgs);
      const upload = await prepareProviderUpload(source);

      assert.notEqual(upload.path, source, ext);
      assert.equal(path.extname(upload.path), ".mp3", ext);
      assert.equal(providerContentType(upload.path), "audio/mpeg", ext);
      assert.ok(isMp3(fs.readFileSync(upload.path)), `${ext} output must be MP3 bytes`);

      const seconds = await decodedSeconds(upload.path, dir);
      assert.ok(Math.abs(seconds - FIXTURE_SECONDS) < 0.15, `${ext} decoded to ${seconds}s`);

      upload.cleanup();
      assert.equal(fs.existsSync(upload.path), false, `${ext} temp MP3 must be removed`);
      assert.ok(fs.existsSync(source), `${ext} source must be untouched`);
    }
  }
);

test("a video container keeps only its audio track", { skip: withoutFfmpeg }, async (t) => {
  const dir = makeTempDir(t);
  const source = writeFixture(
    dir,
    "mp4",
    ["-c:v", "mpeg4", "-c:a", "aac", "-shortest", "-f", "mp4"],
    ["-f", "lavfi", "-i", `testsrc=duration=${FIXTURE_SECONDS}:size=64x64:rate=10`]
  );
  const upload = await prepareProviderUpload(source);
  t.after(() => upload.cleanup());

  assert.ok(isMp3(fs.readFileSync(upload.path)));
  const seconds = await decodedSeconds(upload.path, dir);
  assert.ok(Math.abs(seconds - FIXTURE_SECONDS) < 0.15, `decoded to ${seconds}s`);
});

test(
  "a file ffmpeg cannot decode fails loudly instead of reaching the provider",
  { skip: withoutFfmpeg },
  async (t) => {
    const dir = makeTempDir(t);
    const bogus = path.join(dir, "slides.mov");
    fs.writeFileSync(bogus, "this is not a movie");
    await assert.rejects(prepareProviderUpload(bogus), /FFmpeg exited with code/);
  }
);

test(
  "cancelling before the transcode starts rejects with an AbortError",
  { skip: withoutFfmpeg },
  async (t) => {
    const dir = makeTempDir(t);
    const source = writeFixture(dir, "aiff", ENCODERS.aiff);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(prepareProviderUpload(source, { signal: controller.signal }), {
      name: "AbortError",
    });
  }
);
