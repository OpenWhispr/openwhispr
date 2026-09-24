#!/usr/bin/env node
// Downloads the voice conversation models (Silero VAD, Smart Turn, Pocket TTS)
// into the app's voice-models directory, so the harness runs on any machine.
// The brain (a GGUF LLM) comes from the app's own model manager.
//
// Runs under plain `node`, not Electron, so it can't use the app's
// net.request-based downloadFile (src/helpers/downloadUtils.js). It passes
// this script's own Electron-free downloader instead.
const path = require("path");
const { downloadFile: scriptDownloadFile } = require("./lib/download-utils");
const { downloadVoiceModels, getVoiceModelsDir } = require("../src/helpers/voiceModels");

downloadVoiceModels({
  deps: {
    downloadFile: (url, dest) => {
      console.log(`[voice-models] downloading ${path.basename(url)}`);
      return scriptDownloadFile(url, dest);
    },
  },
})
  .then(() => console.log(`[voice-models] ready in ${getVoiceModelsDir()}`))
  .catch((error) => {
    console.error(`[voice-models] failed: ${error.message}`);
    process.exit(1);
  });
