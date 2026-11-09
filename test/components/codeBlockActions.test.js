const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const {
  SKILLS_MOCKS,
  click,
  findAll,
  label,
  mountSkillsComponent,
  settle,
} = require("../lib/skillsHarness");

const CODE = "scripts/import-to-crm.sh --file acme.md";

async function mountActions(t, { code = CODE } = {}) {
  const calls = { clipboard: [] };
  const mounted = await mountSkillsComponent(t, {
    modulePath: "/components/chat/CodeBlockActions.tsx",
    exportName: "CodeBlockActions",
    props: { code },
    api: {
      writeClipboard: async (text) => {
        calls.clipboard.push(text);
        return { success: true };
      },
    },
  });
  const button = (text) =>
    findAll(mounted.container, (node) => node.tagName === "BUTTON" && label(node) === text)[0];
  return { ...mounted, calls, button };
}

test("Copy writes the code unchanged", async (t) => {
  // Leading spaces and inner lines are part of the code.
  const code = '  for f in *.md; do\n    wc -l "$f"\n  done';
  const { calls, button } = await mountActions(t, { code });

  await click(button("common.copy"));
  await settle();

  assert.deepEqual(calls.clipboard, [code]);
  assert.ok(button("common.copied"), "the button says it copied");
});

test("the main chat shows Copy only on its code blocks", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-code-block-actions-chat-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": SKILLS_MOCKS["react-i18next"],
      "/ui/useToast": SKILLS_MOCKS["/ui/useToast"],
    },
  });
  const { ChatMessage } = await vite.ssrLoadModule("/components/chat/ChatMessage.tsx");
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(ChatMessage, {
        messageId: "m1",
        role: "assistant",
        content: "Run this:\n\n```sh\nls -la\n```\n",
        isStreaming: false,
      })
    )
  );

  const buttons = findAll(container, (node) => node.tagName === "BUTTON").map(label);
  assert.ok(buttons.includes("common.copy"), buttons.join(", "));
  assert.ok(!buttons.includes("skills.code.paste"));
});

test("the actions stay out of a selection and contain no paragraphs", async (t) => {
  const { container } = await mountActions(t);

  const root = container.childNodes[0];
  assert.match(root.getAttribute("class"), /\bselect-none\b/);
  assert.equal(findAll(container, (node) => node.tagName === "P").length, 0);
});
