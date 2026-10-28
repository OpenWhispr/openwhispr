const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/lib/settingsNav.ts");

const ids = (nav, group) => nav.filter((entry) => !group || entry.group === group).map((e) => e.id);

const SIGNED_IN_ADMIN = { isSignedIn: true, hasWorkspace: true, canManageSettings: true };
const SIGNED_IN_MEMBER = { isSignedIn: true, hasWorkspace: true, canManageSettings: false };

test("signed out shows no workspace group", async () => {
  const { buildSettingsNav } = await load();

  const nav = buildSettingsNav({
    isSignedIn: false,
    hasWorkspace: false,
    canManageSettings: false,
  });

  assert.deepEqual(ids(nav, "workspace"), []);
  assert.deepEqual(ids(nav), [
    "account",
    "general",
    "toneStyle",
    "hotkeys",
    "plansBilling",
    "speechToText",
    "llms",
    "privacyData",
    "system",
  ]);
});

test("member sees General and People, no Developer", async () => {
  const { buildSettingsNav } = await load();

  const nav = buildSettingsNav(SIGNED_IN_MEMBER);

  assert.deepEqual(ids(nav, "workspace"), ["workspaceGeneral", "workspacePeople"]);
});

test("admin sees Developer last in the workspace group", async () => {
  const { buildSettingsNav } = await load();

  const nav = buildSettingsNav(SIGNED_IN_ADMIN);

  assert.deepEqual(ids(nav, "workspace"), [
    "workspaceGeneral",
    "workspacePeople",
    "workspaceDeveloper",
  ]);
  assert.deepEqual(
    nav.map((entry) => entry.group),
    [
      "account",
      "account",
      "account",
      "account",
      "account",
      "workspace",
      "workspace",
      "workspace",
      "aiModels",
      "aiModels",
      "system",
      "system",
    ]
  );
});

test("no workspace shows only General in the workspace group", async () => {
  const { buildSettingsNav } = await load();

  const nav = buildSettingsNav({ isSignedIn: true, hasWorkspace: false, canManageSettings: true });

  assert.deepEqual(ids(nav, "workspace"), ["workspaceGeneral"]);
});

test("Tone & Style sits right after Preferences", async () => {
  const { buildSettingsNav } = await load();

  const nav = ids(buildSettingsNav(SIGNED_IN_MEMBER));

  assert.equal(nav[nav.indexOf("general") + 1], "toneStyle");
  assert.deepEqual(ids(buildSettingsNav(SIGNED_IN_MEMBER), "account"), [
    "account",
    "general",
    "toneStyle",
    "hotkeys",
    "plansBilling",
  ]);
});

test("legacy workspace deep link opens General", async () => {
  const { buildSettingsNav, resolveSettingsSection } = await load();

  const nav = buildSettingsNav(SIGNED_IN_MEMBER);

  assert.equal(resolveSettingsSection("workspace", nav), "workspaceGeneral");
});

test("hidden Developer falls back to General", async () => {
  const { buildSettingsNav, resolveSettingsSection } = await load();

  assert.equal(
    resolveSettingsSection("workspaceDeveloper", buildSettingsNav(SIGNED_IN_MEMBER)),
    "workspaceGeneral"
  );
  assert.equal(
    resolveSettingsSection(
      "workspacePeople",
      buildSettingsNav({ isSignedIn: true, hasWorkspace: false, canManageSettings: false })
    ),
    "workspaceGeneral"
  );
  // Signed out there is no workspace group at all.
  assert.equal(
    resolveSettingsSection(
      "workspace",
      buildSettingsNav({ isSignedIn: false, hasWorkspace: false, canManageSettings: false })
    ),
    "account"
  );
});

test("legacy AI aliases still resolve", async () => {
  const { buildSettingsNav, resolveSettingsSection, LEGACY_SUB_TAB } = await load();

  const nav = buildSettingsNav(SIGNED_IN_ADMIN);

  assert.equal(resolveSettingsSection("agentMode", nav), "llms");
  assert.equal(resolveSettingsSection("transcription", nav), "speechToText");
  assert.equal(resolveSettingsSection("permissions", nav), "privacyData");
  assert.equal(resolveSettingsSection("plansBilling", nav), "plansBilling");
  assert.equal(resolveSettingsSection(undefined, nav), "account");
  assert.equal(resolveSettingsSection("noSuchSection", nav), "account");
  assert.equal(LEGACY_SUB_TAB.agentMode, "chatIntelligence");
});
