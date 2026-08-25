#!/usr/bin/env node
const path = require("path");
const { verifyPackagedMacosParakeet } = require("./download-sherpa-onnx");

const appPath = process.argv[2];
if (!appPath) {
  console.error("Usage: node scripts/verify-macos-parakeet.js <OpenWhispr.app>");
  process.exitCode = 1;
} else {
  try {
    const result = verifyPackagedMacosParakeet(path.resolve(appPath));
    console.log(
      `Verified Parakeet ONNX Runtime for ${result.architectures.join(", ")} at macOS ${result.minimumVersion}`
    );
  } catch (error) {
    console.error(`Parakeet compatibility validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
