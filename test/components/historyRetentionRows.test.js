const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");
const { managedPolicy } = require("../helpers/harness/policyFixtures");

const DICTATION = "settingsPage.privacy.transcriptRetention";
const CHATS = "settingsPage.privacy.chatRetention";
const TRANSCRIPTS = "settingsPage.privacy.meetingTranscriptRetention";

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
  } else if (node && typeof node === "object") {
    if (predicate(node)) found.push(node);
    findAll(node.props?.children, predicate, found);
  }
  return found;
}

// Runs the rows' real hooks with their children left unmounted: the element tree, the
// settings store and the confirmation requested are the test boundary.
async function mountRows(t, { settings = {}, policy = null, count = 0 } = {}) {
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });
  const previews = [];
  installBrowserGlobals(t, {
    initialStorage: settings,
    window: {
      electronAPI: {
        retentionPreview: async (kind, days) => {
          previews.push({ kind, days });
          return { count };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-history-retention-rows-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key, options) => (options ? key + " " + JSON.stringify(options) : key);
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
    },
  });
  const [
    { HistoryRetentionRows, TranscriptRetentionRow },
    { useSettingsStore },
    { usePolicyStore },
  ] = await Promise.all([
    vite.ssrLoadModule("/components/settings/HistoryRetentionRows.tsx"),
    vite.ssrLoadModule("/stores/settingsStore.ts"),
    vite.ssrLoadModule("/stores/policyStore.ts"),
  ]);
  if (policy) usePolicyStore.setState({ status: "managed", appVersion: "1.10.0", policy });

  const dialogs = [];
  let tree;
  function Harness() {
    tree = [
      TranscriptRetentionRow(),
      HistoryRetentionRows({ showConfirmDialog: (options) => dialogs.push(options) }),
    ];
    return null;
  }
  const root = createRoot(container);
  rootRef.current = root;
  await React.act(async () => root.render(React.createElement(Harness)));

  const select = (label) =>
    findAll(tree, (node) => node.type === "select" && node.props["aria-label"] === label)[0];
  const row = (label) =>
    findAll(tree, (node) => node.type !== "select" && node.props?.label === label)[0];
  return {
    select,
    row,
    dialogs,
    previews,
    state: () => useSettingsStore.getState(),
    choose: (label, days) =>
      React.act(async () => {
        select(label).props.onChange({ target: { value: String(days) } });
        // The confirmation waits on the count from the main process.
        await new Promise((resolve) => setImmediate(resolve));
      }),
    confirm: (dialog) => React.act(async () => dialog.onConfirm()),
  };
}

test("a shorter period asks first and names what goes", async (t) => {
  const rows = await mountRows(t, { count: 12 });

  await rows.choose(CHATS, 30);

  assert.deepEqual(rows.previews, [{ kind: "chats", days: 30 }]);
  assert.equal(rows.dialogs.length, 1);
  const [dialog] = rows.dialogs;
  assert.equal(dialog.variant, "destructive");
  assert.match(dialog.description, /chatRetentionConfirmDescription/);
  assert.match(dialog.description, /"count":12/);
  assert.match(dialog.description, /retentionDays \{\\"count\\":30\}/);
  assert.equal(rows.state().chatRetentionDays, 0, "nothing changes before the confirmation");

  await rows.confirm(dialog);
  assert.equal(rows.state().chatRetentionDays, 30);
});

test("cancel keeps the old period", async (t) => {
  const rows = await mountRows(t, { settings: { chatRetentionDays: "90" }, count: 3 });

  await rows.choose(CHATS, 7);

  // Cancel closes the dialog without calling onConfirm.
  assert.equal(rows.dialogs.length, 1);
  assert.equal(rows.state().chatRetentionDays, 90);
  assert.equal(rows.select(CHATS).props.value, 90);
});

test("a longer period, or keeping forever, needs no confirmation", async (t) => {
  const rows = await mountRows(t, { settings: { chatRetentionDays: "30" }, count: 5 });

  await rows.choose(CHATS, 60);
  assert.equal(rows.state().chatRetentionDays, 60);
  await rows.choose(CHATS, 0);
  assert.equal(rows.state().chatRetentionDays, 0);

  assert.deepEqual(rows.dialogs, []);
  assert.deepEqual(rows.previews, []);
});

test("a shorter period with nothing to remove applies at once", async (t) => {
  const rows = await mountRows(t, { settings: { chatRetentionDays: "30" }, count: 0 });

  await rows.choose(CHATS, 7);

  assert.deepEqual(rows.dialogs, []);
  assert.equal(rows.state().chatRetentionDays, 7);
});

test("a shorter transcript period asks with the meeting transcript count", async (t) => {
  const rows = await mountRows(t, { count: 4 });

  await rows.choose(TRANSCRIPTS, 14);

  assert.deepEqual(rows.previews, [{ kind: "meetingTranscripts", days: 14 }]);
  const [dialog] = rows.dialogs;
  assert.match(dialog.description, /meetingTranscriptRetentionConfirmDescription/);
  assert.match(dialog.description, /"count":4/);
  assert.equal(rows.state().meetingTranscriptRetentionDays, 0);

  await rows.confirm(dialog);
  assert.equal(rows.state().meetingTranscriptRetentionDays, 14);
});

test("a managed workspace shows Managed by your organization and disables the rows", async (t) => {
  const policy = managedPolicy();
  policy.dataRetention.localHistoryMode = "always_on";
  const rows = await mountRows(t, {
    settings: { chatRetentionDays: "30", meetingTranscriptRetentionDays: "7" },
    policy,
  });

  for (const label of [CHATS, TRANSCRIPTS]) {
    assert.equal(rows.select(label).props.disabled, true, label);
    assert.equal(rows.select(label).props.value, 0, `${label} keeps everything`);
    assert.equal(rows.row(label).props.description, "common.managedByOrg", label);
  }
});

test("a workspace that never keeps history leaves the periods to the user", async (t) => {
  const policy = managedPolicy();
  policy.dataRetention.localHistoryMode = "always_off";
  const rows = await mountRows(t, { settings: { chatRetentionDays: "30" }, policy });

  assert.equal(rows.select(CHATS).props.disabled, false);
  assert.equal(rows.select(CHATS).props.value, 30);
  assert.notEqual(rows.row(CHATS).props.description, "common.managedByOrg");
});

test("the dictation period applies at once, with no confirmation", async (t) => {
  const rows = await mountRows(t, { settings: { transcriptRetentionDays: "30" }, count: 5 });

  await rows.choose(DICTATION, 7);

  assert.equal(rows.state().transcriptRetentionDays, 7);
  assert.deepEqual(rows.dialogs, []);
  assert.deepEqual(rows.previews, []);
});

test("turning local history off disables the dictation period", async (t) => {
  const rows = await mountRows(t, { settings: { dataRetentionEnabled: "false" } });

  assert.equal(rows.select(DICTATION).props.disabled, true);
  assert.equal(rows.row(DICTATION).props.description, `${DICTATION}Description`);
});

test("a workspace that always keeps history locks the dictation period at Forever", async (t) => {
  const policy = managedPolicy();
  policy.dataRetention.localHistoryMode = "always_on";
  const rows = await mountRows(t, { settings: { transcriptRetentionDays: "14" }, policy });

  assert.equal(rows.select(DICTATION).props.disabled, true);
  assert.equal(rows.select(DICTATION).props.value, 0);
  assert.equal(rows.row(DICTATION).props.description, "common.managedByOrg");
  assert.equal(rows.state().transcriptRetentionDays, 14, "the member's own choice is kept");
});

test("a workspace that never keeps history shows the member's dictation period", async (t) => {
  const policy = managedPolicy();
  policy.dataRetention.localHistoryMode = "always_off";
  const rows = await mountRows(t, { settings: { transcriptRetentionDays: "14" }, policy });

  // Disabled because history is off, as before; the organization does not set this period.
  assert.equal(rows.select(DICTATION).props.disabled, true);
  assert.equal(rows.select(DICTATION).props.value, 14);
  assert.equal(rows.row(DICTATION).props.description, `${DICTATION}Description`);
});
