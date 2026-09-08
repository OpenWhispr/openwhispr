const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");

globalThis.React = require("react");

async function initializeI18n() {
  if (i18next.isInitialized) return;
  const en = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  await i18next.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
}

async function component(relativePath) {
  await initializeI18n();
  const module = await import(`../../src/components/${relativePath}.tsx`);
  return module.default.default ?? module.default;
}

function assertState(markup, state, cta) {
  assert.match(markup, new RegExp(`data-leaderboard-state="${state}"`));
  assert.ok(markup.includes(cta), `expected ${state} to show “${cta}”`);
}

test("create renders the workspace funnel and its primary action", async () => {
  const Setup = await component("LeaderboardSetupCard");
  const markup = renderToStaticMarkup(
    createElement(Setup, {
      colleagueCount: 3,
      domain: "acme.com",
      onCreate() {},
    })
  );
  assertState(markup, "create", "Create workspace");
  assert.ok(markup.includes("3 people at acme.com use OpenWhispr"));
});

test("request_join names the matched team and preserves the pending CTA", async () => {
  const RequestJoin = await component("LeaderboardRequestJoinPreview");
  const markup = renderToStaticMarkup(
    createElement(RequestJoin, {
      colleagueCount: 14,
      domain: "acme.com",
      onRequest() {},
      pending: true,
      requesting: false,
      workspaceName: "Acme",
    })
  );
  assertState(markup, "request_join", "Request sent");
  assert.ok(markup.includes("14 people at acme.com already use Acme"));
});

test("accept_invite attributes the inviter and offers a direct join", async () => {
  const AcceptInvite = await component("LeaderboardAcceptInvitePreview");
  const markup = renderToStaticMarkup(
    createElement(AcceptInvite, {
      inviterName: "Sam",
      joining: false,
      onAccept() {},
      workspaceName: "Acme",
    })
  );
  assertState(markup, "accept_invite", "Join Acme");
  assert.ok(markup.includes("Sam invited you"));
});

test("invite keeps the teammate action primary and folds in sync", async () => {
  const Invite = await component("LeaderboardSoloEmptyState");
  const markup = renderToStaticMarkup(
    createElement(Invite, {
      scopeKind: "workspace",
      scopeName: "Acme",
      onInvite() {},
      pendingInvites: ["alex@acme.com"],
      sync: {
        canEnable: true,
        enabled: false,
        error: false,
        onDisable() {},
        onEnable() {},
        ready: true,
        updating: false,
      },
    })
  );
  assertState(markup, "invite", "Invite teammates");
  assert.ok(markup.includes("Analytics Sync"));
  assert.ok(markup.includes("Invited: alex@acme.com"));
});

test("an enabled leaderboard row remains switchable off when enabling is blocked", async () => {
  const SyncRow = await component("LeaderboardSyncRow");
  const markup = renderToStaticMarkup(
    createElement(SyncRow, {
      canEnable: false,
      enabled: true,
      error: false,
      onDisable() {},
      onEnable() {},
      ready: true,
      updating: false,
    })
  );

  assert.match(markup, /<button[^>]*aria-checked="true"/);
  assert.doesNotMatch(markup, /<button[^>]*\sdisabled(?:=|>)/);
});

test("ready with sync off renders the dedicated sync preview", async () => {
  const Sync = await component("LeaderboardSyncPreview");
  const markup = renderToStaticMarkup(
    createElement(Sync, {
      canEnable: true,
      error: false,
      onEnable() {},
      scopeName: "Acme",
      updating: false,
    })
  );
  assertState(markup, "sync", "Opt-in to Leaderboards");
});

test("a ready board with one of five participants renders the inline nudge", async () => {
  const EmptyStrip = await component("LeaderboardEmptyStrip");
  const useToastModule = await import("../../src/components/ui/useToast.ts");
  const ToastContext = useToastModule.ToastContext ?? useToastModule.default.ToastContext;
  const markup = renderToStaticMarkup(
    createElement(
      ToastContext.Provider,
      { value: { toast() {}, dismiss() {}, toastCount: 0, dictationErrorActionCount: 0 } },
      createElement(EmptyStrip, { missingCount: 4 })
    )
  );
  assertState(markup, "empty_strip", "Copy a nudge");
  assert.ok(markup.includes("4 teammates haven&#x27;t turned on Analytics Sync"));
});

test("podium cards accent all three placements", async () => {
  const Podium = await component("LeaderboardPodium");
  const members = [1, 2, 3].map((rank) => ({
    userId: `user-${rank}`,
    name: `Member ${rank}`,
    email: `member-${rank}@acme.com`,
    image: null,
    rank,
    totalWords: 1_000 - rank,
    desktopWords: 900 - rank,
    mobileWords: 100,
    wordsPerMinute: 120,
    currentDailyStreak: 5,
  }));
  const markup = renderToStaticMarkup(
    createElement(Podium, {
      formatValue: (member) => String(member.totalWords),
      members,
      metricLabel: "Total words",
      periodLabel: "Sep 7 – Sep 13",
      title: "Top performers",
    })
  );

  assert.ok(markup.includes("border-amber-400/25 bg-amber-400/5"));
  assert.ok(markup.includes("border-slate-400/30 bg-slate-400/5"));
  assert.ok(markup.includes("border-orange-500/25 bg-orange-500/5"));
});
