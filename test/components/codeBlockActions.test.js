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

async function mountActions(t, { code = CODE, paste = false, pasteText } = {}) {
  const calls = { clipboard: [], paste: [] };
  const mounted = await mountSkillsComponent(t, {
    modulePath: "/components/chat/CodeBlockActions.tsx",
    exportName: "CodeBlockActions",
    props: { code, paste },
    api: {
      writeClipboard: async (text) => {
        calls.clipboard.push(text);
        return { success: true };
      },
      pasteText: async (text, options) => {
        calls.paste.push([text, options]);
        return pasteText ? pasteText() : { success: true, pasted: true };
      },
    },
  });
  const button = (text) =>
    findAll(mounted.container, (node) => node.tagName === "BUTTON" && label(node) === text)[0];
  return { ...mounted, calls, button };
}

const toastTitles = (toasts) => toasts.map((toast) => toast.title);

test("Copy writes the code unchanged", async (t) => {
  // Leading spaces and inner lines are part of the code.
  const code = '  for f in *.md; do\n    wc -l "$f"\n  done';
  const { calls, button } = await mountActions(t, { code });

  await click(button("common.copy"));
  await settle();

  assert.deepEqual(calls.clipboard, [code]);
  assert.ok(button("common.copied"), "the button says it copied");
});

test("Paste into app sends the code unchanged, to the command's app only", async (t) => {
  const { calls, button, toasts } = await mountActions(t, { paste: true });

  await click(button("skills.code.paste"));
  await settle();

  assert.deepEqual(calls.paste, [[CODE, { raw: true, assistantTarget: true }]]);
  assert.deepEqual(toastTitles(toasts), ["skills.code.pasted"]);
});

test("with no app to paste into, the code is copied instead", async (t) => {
  const { calls, button, toasts } = await mountActions(t, {
    paste: true,
    pasteText: () => ({ success: false, pasted: false, reason: "no-target" }),
  });

  await click(button("skills.code.paste"));
  await settle();

  assert.deepEqual(calls.clipboard, [CODE]);
  assert.deepEqual(toastTitles(toasts), ["skills.code.pasteFailed"]);
});

test("a failed paste says the text is on the clipboard", async (t) => {
  // One card, three failures: a clipboard-only paste, a missing Accessibility permission,
  // and a paste that threw before the clipboard was known to hold the code.
  const failures = [
    () => ({ success: true, pasted: false }),
    () => ({ success: false, pasted: false, code: "ACCESSIBILITY_PERMISSION_REQUIRED" }),
    () => Promise.reject(new Error("paste failed")),
  ];
  const { calls, button, toasts } = await mountActions(t, {
    paste: true,
    pasteText: () => failures.shift()(),
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await click(button("skills.code.paste"));
    await settle();
  }

  assert.deepEqual(toastTitles(toasts), Array(3).fill("skills.code.pasteFailed"));
  assert.deepEqual(calls.clipboard, [CODE], "only the throw needed the code put back");
});

// The panel still takes a click once focus has moved to the target app, so a double-click
// would paste the code twice.
test("a second press while a paste runs pastes once", async (t) => {
  let finish;
  const { calls, button, toasts } = await mountActions(t, {
    paste: true,
    pasteText: () =>
      new Promise((resolve) => {
        finish = () => resolve({ success: true, pasted: true });
      }),
  });

  await click(button("skills.code.paste"));
  await click(button("skills.code.paste"));
  finish();
  await settle();

  assert.equal(calls.paste.length, 1);
  assert.deepEqual(toastTitles(toasts), ["skills.code.pasted"]);
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

test("the voice panel's code blocks add Paste into app and its small print", async (t) => {
  const { button, container } = await mountActions(t, { paste: true });

  assert.ok(button("common.copy"));
  assert.ok(button("skills.code.paste"));
  assert.match(container.textContent, /skills\.code\.pasteNote/);
});

// A terminal without bracketed paste runs each pasted line as it lands.
test("a block of several lines offers Copy only, even where Paste into app exists", async (t) => {
  const { button, container } = await mountActions(t, { code: "ls\nrm -rf build", paste: true });

  // Booleans: a failed assert on a node would try to print the whole DOM.
  assert.equal(Boolean(button("common.copy")), true);
  assert.equal(Boolean(button("skills.code.paste")), false);
  assert.doesNotMatch(container.textContent, /skills\.code\.pasteNote/);
});

// Each would make the pasted line act or read differently from the one shown.
test("a line with control, invisible or direction characters offers Copy only", async (t) => {
  for (const code of [
    "ls\r",
    "ls\tpart",
    "echo hi\x0f",
    "\x1b[2Kls",
    "ls\v",
    "ls\u0085",
    "ls\u2028",
    "rm \u202eetadpu",
    "ls\u200b-la",
    "ls\ufeff",
  ]) {
    await t.test(JSON.stringify(code), async (st) => {
      const { button } = await mountActions(st, { code, paste: true });
      assert.equal(Boolean(button("skills.code.paste")), false);
    });
  }
  await t.test("ordinary Unicode still pastes", async (st) => {
    const { button } = await mountActions(st, { code: "echo 'héllo — 世界' | wc -c", paste: true });
    assert.equal(Boolean(button("skills.code.paste")), true);
  });
});

test("the actions stay out of a selection, and the small print isn't a paragraph", async (t) => {
  const { container } = await mountActions(t, { paste: true });

  const root = container.childNodes[0];
  assert.match(root.getAttribute("class"), /\bselect-none\b/);
  // A host's paragraph styles, such as the voice panel's, would resize it.
  assert.equal(findAll(container, (node) => node.tagName === "P").length, 0);
});
