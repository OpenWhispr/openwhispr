const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { createElement } = React;
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

const ENGINEERING = "11111111-1111-4111-8111-111111111111";
const SALES = "22222222-2222-4222-8222-222222222222";

const MOCKS = {
  "react-i18next": `
    const t = (key, options) => (options ? key + JSON.stringify(options) : key);
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
  `,
  // Radix positions the content with layout this DOM doesn't implement.
  "/ui/popover": `
    import { createElement } from "react";
    export const Popover = ({ open, children }) => (open ? children : null);
    export const PopoverAnchor = () => null;
    export const PopoverContent = ({ children }) => createElement("div", { "data-popover": "" }, children);
  `,
};

const entry = (cloudId, word, spaceId) => ({
  cloudId,
  spaceId,
  word,
  addedByUserId: "u-ana",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const SNAPSHOT = {
  entries: [entry("e-qdrant-sales", "Qdrant", SALES), entry("e-arr", "ARR", null)],
  hiddenIds: [],
  meta: {
    scopes: [
      { space_id: null, name: "Acme", member_count: 42, word_count: 1 },
      { space_id: ENGINEERING, name: "Engineering", member_count: 14, word_count: 0 },
      { space_id: SALES, name: "Sales", member_count: 5, word_count: 1 },
    ],
    contributors: [],
    paused: false,
    syncedAt: "2026-10-20T10:00:00.000Z",
  },
};

const t = (key, options) => (options ? key + JSON.stringify(options) : key);

async function renderPopover(t_, words) {
  let root = null;
  t_.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t_);
  const container = installInteractiveDom(t_);
  const vite = await createRendererServer(t_, {
    cachePrefix: "openwhispr-share-popover-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { ShareWordsPopover } = await vite.ssrLoadModule(
    "/components/dictionary/ShareWordsPopover.tsx"
  );
  const { shareTargetsFor } = await vite.ssrLoadModule(
    "/components/dictionary/dictionaryViewModel.ts"
  );
  const shared = [];
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      createElement(ShareWordsPopover, {
        open: true,
        onOpenChange: () => {},
        anchor: null,
        words,
        targets: shareTargetsFor(words, SNAPSHOT, "Acme", t),
        onShare: async (targets) => {
          shared.push(targets);
        },
      })
    )
  );
  return { container, shared };
}

// React writes disabled as an attribute; this DOM has no matching property.
const isDisabled = (node) => node.getAttribute("disabled") !== null;

const click = (element) =>
  React.act(async () => element.dispatchEvent({ type: "click", bubbles: true }));

const option = (container, label) =>
  findElement(
    container,
    (node) => node.getAttribute?.("role") === "checkbox" && node.textContent.startsWith(label)
  );

const shareButton = (container) =>
  findElement(
    container,
    (node) =>
      node.tagName === "BUTTON" &&
      node.getAttribute("role") !== "checkbox" &&
      node.textContent === "dictionary.shared.actions.share"
  );

test("popover disables a list that already has the word", async (t_) => {
  const { container } = await renderPopover(t_, ["Qdrant"]);
  assert.ok(container.textContent.includes('dictionary.shared.share.titleOne{"word":"Qdrant"}'));
  assert.ok(container.textContent.includes("dictionary.shared.share.movesOutOne"));

  const sales = option(container, "Sales");
  assert.equal(isDisabled(sales), true);
  assert.ok(sales.textContent.includes("dictionary.shared.share.alreadyShared"));
  assert.ok(!sales.textContent.includes("5"), "an already-shared list shows no member count");

  const workspace = option(container, 'dictionary.shared.everyoneAt{"workspace":"Acme"}');
  assert.equal(isDisabled(workspace), false);
  assert.ok(workspace.textContent.endsWith("42"));
  assert.ok(option(container, "Engineering").textContent.endsWith("14"));

  await click(sales);
  assert.equal(sales.getAttribute("aria-checked"), "false");
});

test("Share button disabled with no target", async (t_) => {
  const { container, shared } = await renderPopover(t_, ["Biscuit", "Piha"]);
  assert.ok(container.textContent.includes('dictionary.shared.share.titleMany{"count":2}'));
  assert.ok(container.textContent.includes("dictionary.shared.share.movesOutMany"));
  assert.equal(isDisabled(shareButton(container)), true);

  const engineering = option(container, "Engineering");
  await click(engineering);
  assert.equal(engineering.getAttribute("aria-checked"), "true");
  assert.equal(isDisabled(shareButton(container)), false);

  // Unticking the only target disables Share again.
  await click(engineering);
  assert.equal(isDisabled(shareButton(container)), true);

  await click(engineering);
  await click(option(container, 'dictionary.shared.everyoneAt{"workspace":"Acme"}'));
  await click(shareButton(container));
  // Targets go in the order they're listed: the workspace first.
  assert.deepEqual(shared, [[null, ENGINEERING]]);
});
