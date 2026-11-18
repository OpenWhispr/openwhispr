const assert = require("node:assert/strict");
const test = require("node:test");

/** @returns {Promise<typeof import("../../src/lib/workspaceIcon.ts")>} */
const load = () => import("../../src/lib/workspaceIcon.ts");

test("accepts PNG, JPEG, WebP and GIF up to 10 MB", /** @returns {Promise<void>} */ async () => {
  const { checkWorkspaceIconFile, WORKSPACE_ICON_INPUT_MAX_BYTES } = await load();
  assert.equal(WORKSPACE_ICON_INPUT_MAX_BYTES, 10485760);
  for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
    assert.equal(checkWorkspaceIconFile({ type, size: 1024 }), "ok", type);
  }
  assert.equal(checkWorkspaceIconFile({ type: "image/png", size: 10485760 }), "ok");
  assert.equal(checkWorkspaceIconFile({ type: "image/png", size: 10485761 }), "tooLarge");
});

test("refuses SVG, HEIC and files without a type", /** @returns {Promise<void>} */ async () => {
  const { checkWorkspaceIconFile } = await load();
  for (const type of ["image/svg+xml", "image/heic", "application/pdf", ""]) {
    assert.equal(checkWorkspaceIconFile({ type, size: 1024 }), "unsupported", type);
  }
});

test("crops the centred square of the shorter side", /** @returns {Promise<void>} */ async () => {
  const { coverCrop } = await load();
  assert.deepEqual(coverCrop(1000, 500), { sx: 250, sy: 0, side: 500 });
  assert.deepEqual(coverCrop(500, 1000), { sx: 0, sy: 250, side: 500 });
  assert.deepEqual(coverCrop(300, 300), { sx: 0, sy: 0, side: 300 });
  assert.deepEqual(coverCrop(101, 50), { sx: 25, sy: 0, side: 50 });
});

test("an image the browser can't decode is reported as unreadable", /** @returns {Promise<void>} */ async (t) => {
  const { encodeWorkspaceIcon, WorkspaceIconUnreadableError } = await load();
  const original = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => {
    throw new Error("The source image could not be decoded.");
  };
  t.after(() => {
    if (original === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = original;
  });
  await assert.rejects(
    encodeWorkspaceIcon(new Blob(["not an image"])),
    WorkspaceIconUnreadableError
  );
});
