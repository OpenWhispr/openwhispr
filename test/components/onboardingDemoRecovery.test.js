const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

function find(node, name) {
  if (Array.isArray(node)) return node.map((child) => find(child, name)).find(Boolean);
  if (!node || typeof node !== "object") return null;
  return node.type?.name === name ? node : find(node.props?.children, name);
}

async function mountDemo(t, overrides = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__demoSignOut;
  });
  let listener;
  let tree;
  const timers = [];
  const starts = [];
  const ends = [];
  const successes = [];
  installBrowserGlobals(t, {
    window: {
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout() {},
      electronAPI: {
        beginOnboardingDemo: async (session) => {
          starts.push(session);
          return true;
        },
        endOnboardingDemo: async (id) => {
          ends.push(id);
          return true;
        },
        onOnboardingDemoEvent: (callback) => {
          listener = callback;
          return () => {
            listener = null;
          };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-demo-recovery-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = (key) => key; export function useTranslation() { return { t }; }`,
      "canvas-confetti": `export default { create() { return Object.assign(() => {}, { reset() {} }); } };`,
      "onboarding-founder.webp": `export default "founder.webp";`,
      "icons/gmail.svg": `export default "gmail.svg";`,
      "/SignInDialog": `export default function SignInDialog() { return null; }`,
      "/lib/auth": `export async function signOut() { globalThis.__demoSignOut?.(); }`,
    },
  });
  const { default: DemoStep } = await vite.ssrLoadModule("/components/onboarding/DemoStep.tsx");
  const props = {
    kind: "dictation",
    firstMessage: "Hello",
    secondMessage: "Speak",
    listeningLabel: "Listening",
    processingLabel: "Processing",
    stopLabel: "Stop",
    retryLabel: "Retry",
    onSuccessChange: (value) => successes.push(value),
    ...overrides,
  };
  function Harness() {
    tree = DemoStep(props);
    return null;
  }
  root = createRoot(container);
  const render = () =>
    React.act(async () => {
      root.render(React.createElement(Harness));
    });
  await render();
  await React.act(async () => {
    timers.splice(0).forEach((callback) => callback());
  });
  return {
    starts,
    ends,
    successes,
    surface: () => find(tree, "VoiceSurface"),
    dialog: () => find(tree, "SignInDialog"),
    update: async (patch) => {
      Object.assign(props, patch);
      await render();
    },
    retry: async () => React.act(async () => find(tree, "VoiceSurface").props.onRetry()),
    emit: async (event) =>
      React.act(async () => listener?.({ ...starts.at(-1), demoId: starts.at(-1)?.id, ...event })),
  };
}

test("Cloud practice waits for sign-in and resumes in place without losing typed text", async (t) => {
  const demo = await mountDemo(t, { authStatus: "required" });
  assert.equal(demo.starts.length, 0);
  assert.equal(demo.surface().props.retryLabel, "auth.passwordForm.signInLink");
  assert.doesNotMatch(demo.surface().props.event.message, /Settings/);
  await React.act(async () => {
    demo.surface().props.onChange("Keep my draft");
    demo.surface().props.onRetry();
  });
  assert.equal(demo.dialog().props.open, true);
  await demo.update({ authStatus: "ready" });
  assert.equal(demo.starts.length, 0, "dialog still pauses capture");
  await React.act(async () => demo.dialog().props.onAuthComplete());
  assert.equal(demo.surface().props.value, "Keep my draft");
  assert.equal(demo.starts.length, 1);
});

test("expired sign-in offers sign-in, not another doomed recording", async (t) => {
  const demo = await mountDemo(t);
  await demo.emit({ status: "error", code: "AUTH_EXPIRED", message: "Sign in from Settings" });
  assert.equal(demo.surface().props.retryLabel, "auth.passwordForm.signInLink");
  assert.doesNotMatch(demo.surface().props.event.message, /Settings/);
  assert.equal(demo.ends.length, 1);
  let signedOut = false;
  globalThis.__demoSignOut = () => {
    signedOut = true;
  };
  await demo.retry();
  assert.equal(signedOut, true, "cached authentication must not auto-complete recovery");
  assert.equal(demo.dialog().props.open, true);
});

test("cancellation clears listening and a new attempt clears previous completion", async (t) => {
  const demo = await mountDemo(t);
  await demo.emit({ status: "success", text: "First result" });
  assert.equal(demo.successes.at(-1), true);
  await demo.emit({ status: "listening" });
  assert.equal(demo.successes.at(-1), false);
  await demo.emit({ status: "cancelled" });
  assert.equal(demo.surface().props.event, null);
  await demo.emit({ status: "listening" });
  assert.equal(demo.surface().props.event.status, "listening");
});

test("Cloud practice waits while authentication resolves", async (t) => {
  const demo = await mountDemo(t, { authStatus: "loading" });
  assert.equal(demo.starts.length, 0);
  await demo.update({ authStatus: "ready" });
  assert.equal(demo.starts.length, 1);
});

test("a failed practice start settles and can be retried", async (t) => {
  const demo = await mountDemo(t, { authStatus: "loading" });
  globalThis.window.electronAPI.beginOnboardingDemo = async () => {
    throw new Error("IPC unavailable");
  };
  await demo.update({ authStatus: "ready" });
  assert.equal(demo.surface().props.event.status, "error");
  globalThis.window.electronAPI.beginOnboardingDemo = async () => true;
  await demo.retry();
  assert.ok(!demo.surface(), "retry restarts the lesson's introduction");
});

test("sign-in checkpoints the practice text before authentication can remount it", async (t) => {
  let saved;
  const demo = await mountDemo(t, {
    authStatus: "required",
    initialDraft: { text: "Earlier text", transcript: "Earlier request" },
    onRecoveryDraft: (draft) => {
      saved = draft;
    },
  });
  assert.equal(demo.surface().props.value, "Earlier text");
  await React.act(async () => demo.surface().props.onChange("Edited text"));
  await demo.retry();
  assert.deepEqual(saved, { text: "Edited text", transcript: "Earlier request" });
});

for (const code of ["AUTH_REQUIRED", "AUTH_EXPIRED", undefined]) {
  test(`Assistant reasoning ${code ?? "generic error"} retains usable recovery`, async (t) => {
    const demo = await mountDemo(t, { kind: "assistant" });
    await demo.emit({ status: "error", code, message: "Request failed" });
    assert.equal(demo.surface().props.retryLabel, code ? "auth.passwordForm.signInLink" : "Retry");
    await demo.retry();
    if (code) {
      assert.equal(demo.dialog().props.open, true);
      await React.act(async () => demo.dialog().props.onAuthComplete());
      assert.equal(demo.starts.length, 2);
    } else {
      assert.equal(demo.surface().props.event, null);
      assert.equal(demo.starts.length, 2, "generic retry starts another recording session");
    }
  });
}

test("preparing clears Assistant success and draft before microphone listening", async (t) => {
  const demo = await mountDemo(t, { kind: "assistant" });
  await demo.emit({ status: "success", text: "Old reply" });
  assert.equal(demo.successes.at(-1), true);
  await demo.emit({ status: "preparing" });
  assert.equal(demo.successes.at(-1), false);
  assert.equal(demo.surface().props.value, "");
  assert.equal(demo.surface().props.transcript, "");
  assert.equal(demo.surface().props.event.status, "preparing");
  const markup = renderToStaticMarkup(demo.surface());
  assert.match(markup, /role="status"/);
  assert.match(markup, /cursor:not-allowed/);
  assert.doesNotMatch(markup, /Listening|aria-label="Stop"|role="button"/);
  assert.match(markup, /class="voice-pill-waveform[^"]*" style="width:0;/);
});

for (const source of ["typed", "recovered"]) {
  for (const terminal of ["error", "cancelled"]) {
    test(`Dictation preserves ${source} text through ${terminal} startup`, async (t) => {
      const text = "My existing draft";
      const demo = await mountDemo(t, {
        kind: "dictation",
        ...(source === "recovered"
          ? { initialDraft: { text, transcript: "Recovered transcript" } }
          : {}),
      });
      if (source === "typed") await React.act(async () => demo.surface().props.onChange(text));
      for (const status of ["preparing", "listening"]) {
        await demo.emit({ status });
        assert.equal(demo.surface().props.value, text);
      }
      await demo.emit({ status: terminal, message: "Microphone unavailable" });
      assert.equal(demo.surface().props.value, text);
    });
  }
}
