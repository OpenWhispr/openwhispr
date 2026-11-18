// FEAT-06 contract: every entry point to a feature the fork dropped must route through
// cloudFeatureVisible(<id>, CLOUD_ENABLED). This is a source-level tripwire: if a mount
// site stops calling the gate (or a refactor moves it), the entry point would reappear in
// a fork build unnoticed, because several of them are only hidden today by the OpenWhispr
// session never signing in. Add a row here for every new dropped-feature entry point.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

// {file, id, anchor}: the gate call must exist, and the gated element's name (anchor)
// must appear within the lines after it.
const MOUNT_SITES = [
  { file: "src/components/ControlPanelSidebar.tsx", id: "referral", anchor: "onOpenReferrals" },
  {
    file: "src/components/ControlPanelSidebar.tsx",
    id: "workspaceSwitcher",
    anchor: "<WorkspaceSwitcher",
  },
  { file: "src/components/ControlPanel.tsx", id: "upgradePrompt", anchor: "<UpgradePrompt" },
  {
    file: "src/components/ControlPanel.tsx",
    id: "upgradePrompt",
    anchor: "setShowUpgradePrompt(true)",
  },
  { file: "src/components/ControlPanel.tsx", id: "referral", anchor: "showReferrals" },
  { file: "src/components/ControlPanel.tsx", id: "referral", anchor: "setShowReferrals(true)" },
  { file: "src/components/ControlPanel.tsx", id: "teamJoin", anchor: "<JoinYourTeamModal" },
  { file: "src/components/ControlPanel.tsx", id: "teamJoin", anchor: "<AcceptInvitationModal" },
  {
    file: "src/components/ControlPanel.tsx",
    id: "teamJoin",
    anchor: "isSignedIn && !invitationToken",
  },
  // InsightsView computes the gate once (leaderboardVisible); the trigger, the content and
  // the active tab all render under it.
  { file: "src/components/InsightsView.tsx", id: "leaderboard", anchor: "leaderboardVisible &&" },
  {
    file: "src/components/InsightsView.tsx",
    id: "leaderboard",
    anchor: "leaderboardVisible ? selectedTab",
  },
  {
    file: "src/components/SettingsPage.tsx",
    id: "leaderboard",
    anchor: 'label={t("insights.leaderboard.title")}',
  },
  {
    file: "src/components/SettingsPage.tsx",
    id: "cloudBackup",
    anchor: 'label={t("settingsPage.privacy.cloudBackup")}',
  },
  {
    file: "src/components/SettingsPage.tsx",
    id: "cloudBackup",
    anchor: 'label={t("settingsPage.privacy.insightsSync")}',
  },
  {
    file: "src/components/SettingsPage.tsx",
    id: "enterpriseCheckout",
    anchor: "<EnterpriseCheckoutDialog",
  },
  {
    file: "src/components/notes/NoteEditor.tsx",
    id: "shareLink",
    anchor: 'openShare("copy-link")',
  },
  // ShareNoteDialog: the whole sync/link block is one gated fragment; export stays outside it.
  {
    file: "src/components/notes/ShareNoteDialog.tsx",
    id: "shareLink",
    anchor: "syncAndShare",
  },
  { file: "src/utils/signInCloudNudge.ts", id: "signInCloudNudge", anchor: "NaN" },
];

// A gate call for `id` must appear on a line before the anchor, with at most this many
// lines between them (the gate wraps the element it hides).
const GATE_WINDOW_LINES = 40;

for (const { file, id, anchor } of MOUNT_SITES) {
  test(`${file} gates "${anchor}" on cloudFeatureVisible("${id}")`, () => {
    const lines = read(file).split("\n");
    const gateRe = new RegExp(`cloudFeatureVisible\\(\\s*"${id}"`);
    const anchorLines = lines
      .map((line, index) => (line.includes(anchor) ? index : -1))
      .filter((index) => index >= 0);
    assert.ok(anchorLines.length > 0, `anchor not found: ${anchor}`);
    const gated = anchorLines.some((anchorLine) =>
      lines
        .slice(Math.max(0, anchorLine - GATE_WINDOW_LINES), anchorLine + 1)
        .some((line) => gateRe.test(line))
    );
    assert.ok(gated, `${anchor} is not preceded by cloudFeatureVisible("${id}", ...)`);
  });
}

test("every mount-site file passes CLOUD_ENABLED (not the OpenWhispr session) to the gate", () => {
  for (const file of new Set(MOUNT_SITES.map((site) => site.file))) {
    const source = read(file);
    for (const match of source.matchAll(
      /cloudFeatureVisible\(\s*"[A-Za-z]+"\s*,\s*([A-Za-z_]+)/g
    )) {
      assert.ok(
        match[1] === "CLOUD_ENABLED" || match[1] === "cloudEnabled",
        `${file}: gate fed by ${match[1]}`
      );
    }
  }
});

// Audit rows (FEAT-06 Task 3): searched and found no reachable entry point in a fork build.
// Re-run these to reproduce; each is expected to stay empty of un-gated hits.
//   - Mobile sync / companion pairing: grep -rniE "mobile.?(sync|pair)|qr.?pair" src main.js
//   - Hosted API/MCP/CLI developer panes: gated by CLOUD_ENABLED in
//     src/components/integrations/integrationsSections.ts (developer group).
//   - Enterprise admin console links: reached only through Settings sections workspace /
//     plansBilling, which CLOUD_ONLY_SECTIONS hides (src/config/cloudSections.ts).
//   - Cloud note search: searchNotesTool.ts tries cloud, then local semantic, then FTS5;
//     with no API URL the cloud step is skipped, and there is no UI toggle for it.
test("developer integrations and cloud-only settings sections stay hidden in a fork build", () => {
  const sections = read("src/config/cloudSections.ts");
  assert.match(sections, /CLOUD_ONLY_SECTIONS[^\n]*"account"[^\n]*"plansBilling"[^\n]*"workspace"/);
  const integrations = read("src/components/integrations/integrationsSections.ts");
  assert.match(integrations, /CLOUD_ENABLED/);
});
