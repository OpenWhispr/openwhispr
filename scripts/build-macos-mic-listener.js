#!/usr/bin/env node

const { buildMacosSwiftBinary } = require("./lib/build-macos-swift-binary");

buildMacosSwiftBinary({
  label: "mic-listener",
  sourceName: "macos-mic-listener.swift",
  binaryName: "macos-mic-listener",
  frameworks: ["CoreAudio", "Foundation"],
});
