#!/usr/bin/env node
// Downloads the voice conversation models (Silero VAD, Smart Turn, Supertonic TTS)
// into the app's voice-models directory, so the harness runs on any machine.
// The brain (a GGUF LLM) comes from the app's own model manager.
//
// Runs under plain `node`, not Electron, so it can't use the app's
// net.request-based downloadFile (src/helpers/downloadUtils.js). It passes
// this script's own Electron-free downloader instead.
const fs = require("fs");
const path = require("path");
const { downloadFile: scriptDownloadFile } = require("./lib/download-utils");
const { downloadVoiceModels, getVoiceModelsDir } = require("../src/helpers/voiceModels");

downloadVoiceModels({
  deps: {
    // This downloader writes in place; land the file like the app's does, so an
    // interrupted run never leaves a partial model that reads as ready.
    downloadFile: async (url, dest) => {
      console.log(`[voice-models] downloading ${path.basename(url)}`);
      await scriptDownloadFile(url, `${dest}.tmp`);
      fs.renameSync(`${dest}.tmp`, dest);
    },
  },
})
  .then(() => console.log(`[voice-models] ready in ${getVoiceModelsDir()}`))
  .catch((error) => {
    console.error(`[voice-models] failed: ${error.message}`);
    process.exit(1);
  });
