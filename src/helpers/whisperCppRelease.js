const WHISPER_CPP_TAG = process.env.WHISPER_CPP_VERSION || "0.0.10";

const WINDOWS_MSVC_RUNTIME_LIBRARIES = Object.freeze([
  "msvcp140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "vcomp140.dll",
]);

module.exports = { WHISPER_CPP_TAG, WINDOWS_MSVC_RUNTIME_LIBRARIES };
