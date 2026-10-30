const test = require("node:test");
const assert = require("node:assert/strict");

// qualcommWhisper pulls Electron-coupled helpers; modelDirUtils guards `app`
// with an optional-call, so plain Node loads it like the build tooling does.
const { resolveReleaseAssetUrl } = require("../../src/helpers/qualcommWhisper");

const RELEASE_ASSETS = {
  version: "0.65.0",
  precisions: {
    float: {
      chipset_assets: {
        "qualcomm-qcs8275": {
          precompiled_qnn_onnx: { download_url: "https://example.invalid/qcs8275.zip" },
        },
        "qualcomm-snapdragon-x-elite": {
          precompiled_qnn_onnx: { download_url: "https://example.invalid/xelite.zip" },
        },
        "qualcomm-snapdragon-x2-elite": {
          qnn_context_binary: { download_url: "https://example.invalid/x2.bin.zip" },
        },
      },
    },
  },
};

test("resolves the X Elite precompiled QNN ONNX export first", () => {
  const asset = resolveReleaseAssetUrl(RELEASE_ASSETS);
  assert.deepEqual(asset, {
    url: "https://example.invalid/xelite.zip",
    chipset: "qualcomm-snapdragon-x-elite",
    precision: "float",
  });
});

test("falls back to the X2 Elite export when X Elite is absent", () => {
  const assets = {
    precisions: {
      float: {
        chipset_assets: {
          "qualcomm-snapdragon-x2-elite": {
            precompiled_qnn_onnx: { download_url: "https://example.invalid/x2.zip" },
          },
        },
      },
    },
  };
  const asset = resolveReleaseAssetUrl(assets);
  assert.equal(asset.chipset, "qualcomm-snapdragon-x2-elite");
  assert.equal(asset.url, "https://example.invalid/x2.zip");
});

test("returns null when no Snapdragon export exists (no Android-only resolution)", () => {
  const assets = {
    precisions: {
      float: {
        chipset_assets: {
          "qualcomm-snapdragon-8gen3": {
            precompiled_qnn_onnx: { download_url: "https://example.invalid/mobile.zip" },
          },
        },
      },
    },
  };
  assert.equal(resolveReleaseAssetUrl(assets), null);
});
