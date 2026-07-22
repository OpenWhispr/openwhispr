#!/usr/bin/env node

const { buildMacosSwiftBinary } = require("./lib/build-macos-swift-binary");

buildMacosSwiftBinary({
  label: "globe-listener",
  sourceName: "macos-globe-listener.swift",
  binaryName: "macos-globe-listener",
});
