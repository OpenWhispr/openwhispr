#!/usr/bin/env node

const { buildMacosSwiftBinary } = require("./lib/build-macos-swift-binary");

buildMacosSwiftBinary({
  label: "window-bounds",
  sourceName: "macos-window-bounds.swift",
  binaryName: "macos-window-bounds",
});
