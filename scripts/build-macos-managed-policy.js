#!/usr/bin/env node
const { buildMacosSwiftBinary } = require("./lib/build-macos-swift-binary");

buildMacosSwiftBinary({
  label: "managed-policy",
  sourceName: "macos-managed-policy.swift",
  binaryName: "macos-managed-policy",
  frameworks: ["Foundation", "CoreFoundation"],
});
