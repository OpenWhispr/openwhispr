const test = require("node:test");
const assert = require("node:assert/strict");
const { changedArtifacts, verifyArtifact } = require("../lib/artifacts.cjs");
const { readCatalog } = require("../lib/catalog.cjs");

const base = readCatalog();
const sha = "a".repeat(64);
const gguf = {
  key: "localProviders/qwen/new",
  kind: "gguf",
  url: `https://huggingface.co/Qwen/Repo/resolve/${"b".repeat(40)}/model.gguf`,
  sha256: sha,
  size: 1000,
};

function fakeFetch({ tree = [], magic = "GGUF", release = null, bytes = "" }) {
  return async (url) => {
    if (url.includes("/api/models/")) return Response.json(tree);
    if (url.includes("api.github.com")) return release ? Response.json(release) : new Response("", { status: 404 });
    if (url.includes("huggingface.co")) return new Response(magic);
    return new Response(bytes);
  };
}

test("only new or changed downloads are re-checked", () => {
  assert.deepEqual(changedArtifacts(base, base), []);
  const next = structuredClone(base);
  next.whisperModels.base.sha256 = sha;
  assert.deepEqual(
    changedArtifacts(next, base).map((artifact) => artifact.key),
    ["whisperModels/base"]
  );
});

test("a Hugging Face file must exist with the declared hash, size and GGUF header", async () => {
  const entry = { path: "model.gguf", size: 1000, lfs: { oid: sha, size: 1000 } };
  assert.deepEqual(await verifyArtifact(gguf, { fetch: fakeFetch({ tree: [entry] }) }), []);
  for (const [fake, message] of [
    [{ tree: [] }, /does not exist/],
    [{ tree: [{ ...entry, lfs: { oid: "0".repeat(64), size: 1000 } }] }, /sha256 is 0+/],
    [{ tree: [{ ...entry, lfs: { oid: sha, size: 7 } }] }, /size is 7/],
    [{ tree: [entry], magic: "hello" }, /is not a GGUF file/],
  ]) {
    const problems = await verifyArtifact(gguf, { fetch: fakeFetch(fake) });
    assert.match(problems.join("\n"), message);
  }
});

test("only trusted Hugging Face publishers can supply files", async () => {
  const entry = { path: "model.gguf", size: 1000, lfs: { oid: sha, size: 1000 } };
  const problems = await verifyArtifact(
    { ...gguf, url: gguf.url.replace("/Qwen/", "/someone/") },
    { fetch: fakeFetch({ tree: [entry] }) }
  );
  assert.match(problems.join("\n"), /not a trusted Hugging Face publisher/);
});

test("GitHub release assets are checked by digest, or downloaded and hashed", async () => {
  const archive = {
    key: "parakeetModels/new",
    kind: "archive",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/model.tar.bz2",
    size: 5,
  };
  const bytes = "hello";
  const digest = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const asset = { name: "model.tar.bz2", size: 5 };
  const withDigest = fakeFetch({ release: { assets: [{ ...asset, digest: `sha256:${digest}` }] } });
  assert.deepEqual(await verifyArtifact({ ...archive, sha256: digest }, { fetch: withDigest }), []);
  const downloaded = fakeFetch({ release: { assets: [{ ...asset, digest: null }] }, bytes });
  assert.deepEqual(await verifyArtifact({ ...archive, sha256: digest }, { fetch: downloaded }), []);
  assert.match(
    (await verifyArtifact({ ...archive, sha256: sha }, { fetch: downloaded })).join("\n"),
    /sha256 is/
  );
  assert.match(
    (await verifyArtifact(archive, { fetch: fakeFetch({ release: { assets: [] } }) })).join("\n"),
    /is not attached/
  );
});
