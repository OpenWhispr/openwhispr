const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  return predicate(node) ? node : findElement(node.props?.children, predicate);
}

test("local model cards only select approved installed choices and keep Delete available", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-policy-model-cards-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export function useTranslation() { return { t: (key) => key }; }`,
    },
  });
  const { ModelCard } = await vite.ssrLoadModule("/components/ui/ModelCardList.tsx");
  for (const fixture of [
    { downloaded: false, blocked: false, legacy: false, selectable: false, downloadable: true },
    { downloaded: true, blocked: false, legacy: false, selectable: true, downloadable: false },
    { downloaded: false, blocked: true, legacy: false, selectable: false, downloadable: false },
    { downloaded: true, blocked: true, legacy: false, selectable: false, downloadable: false },
    { downloaded: true, blocked: true, legacy: true, selectable: false, downloadable: false },
  ]) {
    const selected = [];
    const deleted = [];
    const downloaded = [];
    const tree = ModelCard({
      model: {
        value: "qwen3.5-4b-q4_k_m",
        label: "Qwen",
        isDownloaded: fixture.downloaded,
        policyBlocked: fixture.blocked,
        legacy: fixture.legacy,
      },
      isSelected: false,
      onSelect: (id) => selected.push(id),
      onDownload: (id) => downloaded.push(id),
      onDelete: (id) => deleted.push(id),
    });
    tree.props.onClick();
    assert.equal(selected.length, Number(fixture.selectable), JSON.stringify(fixture));
    const downloadButton = findElement(
      tree,
      (node) =>
        Array.isArray(node.props?.children) && node.props.children.includes("common.download")
    );
    assert.equal(Boolean(downloadButton), fixture.downloadable, JSON.stringify(fixture));
    if (downloadButton) downloadButton.props.onClick({ stopPropagation() {} });
    assert.equal(downloaded.length, Number(fixture.downloadable));
    const deleteButton = findElement(
      tree,
      (node) => node.props?.["aria-label"] === "common.delete"
    );
    assert.equal(Boolean(deleteButton), fixture.downloaded, JSON.stringify(fixture));
    if (deleteButton) deleteButton.props.onClick({ stopPropagation() {} });
    assert.equal(deleted.length, Number(fixture.downloaded));
  }
});
