#!/usr/bin/env node

const { buildMacosSwiftBinary } = require("./lib/build-macos-swift-binary");

buildMacosSwiftBinary({
  label: "text-monitor",
  sourceName: "macos-text-monitor.swift",
  binaryName: "macos-text-monitor",
});
