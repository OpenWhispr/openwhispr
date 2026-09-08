const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");

test("the leaderboard is tabbed inside the Insights view", () => {
  const controlPanel = read("src/components/ControlPanel.tsx");
  const sidebar = read("src/components/ControlPanelSidebar.tsx");
  const insights = read("src/components/InsightsView.tsx");
  const leaderboard = read("src/components/LeaderboardView.tsx");
  const dictionary = read("src/components/DictionaryView.tsx");

  assert.equal(sidebar.includes('| "leaderboard"'), false);
  assert.equal(sidebar.includes('{ id: "leaderboard"'), false);
  assert.equal(controlPanel.includes('activeView === "leaderboard"'), false);
  assert.equal(controlPanel.includes('import("./LeaderboardView")'), false);
  assert.ok(controlPanel.includes("<InsightsView"));
  assert.ok(insights.includes('useState("usage")'));
  assert.equal(insights.match(/<TabsTrigger/g)?.length, 2);
  assert.ok(insights.includes('value="usage"'));
  assert.ok(insights.includes('t("insights.yourUsage")'));
  assert.ok(insights.includes('value="leaderboard"'));
  assert.ok(dictionary.includes('className="h-7 p-0.5 rounded-[7px]"'));
  assert.ok(insights.includes('className="h-7 self-start p-0.5 rounded-[7px]"'));
  assert.ok(dictionary.includes('className="h-6 px-2.5 text-xs rounded-[5px]"'));
  assert.ok(insights.includes('className="h-6 px-2.5 text-xs rounded-[5px]"'));
  assert.ok(insights.includes("<LeaderboardView"));
  assert.ok(insights.includes("syncService.syncAnalyticsNow()"));
  assert.equal(insights.includes("syncPendingAnalytics"), false);
  assert.ok(insights.includes("onClick={() => void joinLeaderboard()}"));
  assert.ok(insights.includes('"insights.enableSync"'));
  assert.ok(insights.includes("onSyncErrorChange={setSyncError}"));
  const usageContent = insights.slice(
    insights.indexOf('<TabsContent value="usage"'),
    insights.indexOf('<TabsContent value="leaderboard"')
  );
  assert.ok(usageContent.includes("isLoaded && !syncActive"));
  assert.ok(usageContent.includes('t("insights.onDevicePrivacy")'));
  assert.ok(usageContent.includes("mt-auto pt-8"));
  assert.equal(
    insights
      .slice(insights.indexOf('<TabsContent value="leaderboard"'))
      .includes("onDevicePrivacy"),
    false
  );
  assert.ok(leaderboard.includes("<LeaderboardSection"));
  assert.equal(
    leaderboard.includes("useInsightsSyncOptIn"),
    false,
    "the nested tab must reuse the page's opt-in owner instead of duplicating analytics IPCs"
  );
  assert.equal(leaderboard.includes("onJoin="), false);
  assert.equal(leaderboard.includes('<h1 className="text-base!'), false);
  assert.equal(leaderboard.includes('t("insights.leaderboard.description")'), false);
});

test("combined sync consent copy is concise and discloses profile sharing", () => {
  for (const locale of ["en", "de", "es", "fr", "it", "ja", "pt", "ru", "zh-CN", "zh-TW"]) {
    const { insights } = JSON.parse(read(`src/locales/${locale}/translation.json`));
    const descriptions = [
      insights.syncAndJoinDisclosure,
      insights.syncAndJoinEmptyDescription,
      insights.leaderboard.syncDescription,
      ...Object.entries(insights)
        .filter(([key]) => /^(claim|enable)Description_/.test(key))
        .map(([, value]) => value),
    ];
    for (const description of descriptions) {
      assert.ok(description.length <= 190, `${locale} consent copy is too long`);
      assert.doesNotMatch(description, /[—–]/, `${locale} consent copy must not use long dashes`);
    }
  }

  const english = JSON.parse(read("src/locales/en/translation.json")).insights;
  assert.match(english.leaderboard.syncDescription, /name, email, and activity/);
  assert.doesNotMatch(english.leaderboard.syncDescription, /Only activity counters/);
});

test("leaderboard access is plan agnostic and invitation led", () => {
  const controlPanel = read("src/components/ControlPanel.tsx");
  const section = read("src/components/LeaderboardSection.tsx");
  const view = read("src/components/LeaderboardView.tsx");

  assert.equal(section.includes("LeaderboardFreePreview"), false);
  assert.equal(view.includes("onUpgrade"), false);
  assert.ok(section.includes("openLeaderboardGrowthAction"));
  assert.ok(section.includes('"insights.leaderboard.inviteCta"'));
  assert.ok(section.includes('selectedScope.kind === "domain"'));
  assert.ok(section.includes('scope.kind === "workspace"'));
  assert.ok(section.includes('"settingsPage.workspace.empty.create"'));
  assert.ok(section.includes("setCreateWorkspaceOpen(true)"));
  assert.ok(section.includes("boardParticipantCount"));
  assert.ok(section.includes("visibleLeaderboard?.totalMembers"));
  assert.ok(section.includes("<LeaderboardSetupCard"));
  assert.ok(section.includes("<LeaderboardSoloEmptyState"));
  assert.ok(section.includes("<LeaderboardAcceptInvitePreview"));
  assert.ok(section.includes("afterWorkspaceJoined"));
  assert.ok(section.includes("InvitationsService.list"));
  assert.ok(section.includes("<LeaderboardEmptyStrip"));
  assert.ok(section.includes('data-leaderboard-state="board"'));
  assert.ok(section.includes("resolveLeaderboardScopeKey"));
  assert.ok(section.includes('t("insights.leaderboard.chooseBoard")'));
  assert.ok(section.includes('selectedScope?.state === "invite"'));
  assert.ok(section.includes("<LeaderboardSyncPreview"));
  assert.equal(section.includes("<LeaderboardSyncRow"), false);
  assert.equal(section.includes("activationDescription"), false);
  assert.ok(controlPanel.includes("onInvite={() => setShowReferrals(true)}"));
});

test("leaderboard access waits for validated auth and labels ranked participants", () => {
  const section = read("src/components/LeaderboardSection.tsx");
  const accessLoader = section.slice(
    section.indexOf("const loadAccess"),
    section.indexOf("useEffect(() =>", section.indexOf("const loadAccess"))
  );
  const boardHeader = section.slice(
    section.indexOf('data-leaderboard-state="board"'),
    section.indexOf("<DropdownMenu", section.indexOf('data-leaderboard-state="board"'))
  );

  assert.ok(
    accessLoader.indexOf("authGeneration == null") <
      accessLoader.indexOf("LeaderboardService.getAccess()")
  );
  assert.ok(accessLoader.includes("[accountId, authGeneration]"));
  assert.ok(boardHeader.includes("boardParticipantCount"));
  assert.equal(boardHeader.includes("selectedScope.memberCount"), false);
});

test("an SSO-required board starts company reauthentication directly", () => {
  const section = read("src/components/LeaderboardSection.tsx");
  const view = read("src/components/LeaderboardView.tsx");
  const recovery = section.slice(
    section.indexOf('visibleFailure === "sso"'),
    section.indexOf(") : !visibleLeaderboard")
  );
  assert.ok(
    recovery.includes('"auth.sso.continueWithSSO"'),
    "the recovery card must name the existing SSO action"
  );
  assert.ok(recovery.includes("onSsoSignIn"));
  assert.ok(view.includes("signInWithSSO(email)"));
  assert.ok(view.includes("getOAuthProtocolRegistered"));
  assert.ok(view.includes('t("auth.social.protocolUnavailable")'));
  assert.ok(view.includes("oauthProtocolRegistered !== true || ssoStarting"));
  assert.ok(view.includes('window.addEventListener("focus", handleFocus)'));
});
