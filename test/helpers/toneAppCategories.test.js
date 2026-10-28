const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyToneAppCategory } = require("../../src/helpers/toneAppCategories");

const categoryOf = (appSignature, extra = {}) =>
  classifyToneAppCategory({ appSignature, ...extra });

// Each signature is the shape one platform hands the classifier: macOS
// "<app name> <bundle id>", Windows "<exe> <window class>", Linux "<WM_CLASS>".
test("desktop apps map to their category on every platform", () => {
  const expectations = {
    personal: [
      "WhatsApp net.whatsapp.WhatsApp",
      "Telegram ru.keepcoder.Telegram",
      "Messages com.apple.MobileSMS",
      "Signal org.whispersystems.signal-desktop",
      "Discord com.hnc.Discord",
      "LINE jp.naver.line.mac",
      // macOS names translate; the bundle id still names the app.
      "微信 com.tencent.xinWeChat",
      "카카오톡 com.kakao.KakaoTalkMac",
      "WhatsApp.exe ApplicationFrameWindow",
      "Telegram.exe Qt51517QWindowIcon",
      "LINE.exe",
      "PhoneExperienceHost.exe",
      "org.telegram.desktop",
      "signal",
    ],
    work: [
      "Slack com.tinyspeck.slackmacgap",
      "Microsoft Teams com.microsoft.teams2",
      "zoom.us us.zoom.xos",
      "slack.exe Chrome_WidgetWin_1",
      "ms-teams.exe TeamsWebView",
      "Zoom.exe ZPContentViewWndClass",
      "teams-for-linux",
      "mattermost",
      "钉钉 com.alibaba.DingTalkMac",
      "企业微信 com.tencent.WeWorkMac",
    ],
    email: [
      "Mail com.apple.mail",
      "Microsoft Outlook com.microsoft.Outlook",
      "Superhuman com.superhuman.electron",
      "Spark Desktop com.readdle.SparkDesktop",
      "Mimestream com.mimestream.Mimestream",
      "Canary Mail io.canarymail.mac",
      "Proton Mail ch.protonmail.desktop",
      "OUTLOOK.EXE rctrl_renwnd32",
      "olk.exe",
      "MailClient.exe",
      "thunderbird",
      "org.gnome.Evolution",
      "geary",
      "org.kde.kmail2",
    ],
  };
  for (const [category, signatures] of Object.entries(expectations)) {
    for (const signature of signatures) {
      assert.equal(categoryOf(signature), category, signature);
    }
  }
});

test("unlisted apps and look-alike names are other", () => {
  for (const signature of [
    "Notion notion.id",
    "Visual Studio Code com.microsoft.VSCode",
    "Google Chrome Canary com.google.Chrome.canary", // a browser with no page known
    "Notion.exe Chrome_WidgetWin_1", // the Chromium class alone isn't a browser
    "Mailchimp", // "mail" only as a whole token
    "Slackware Installer",
    "Teamspeak",
    "",
  ]) {
    assert.equal(categoryOf(signature), "other", signature);
  }
  assert.equal(classifyToneAppCategory(null), "other");
});

test("a browser is judged by the page's host", () => {
  const chrome = "Google Chrome com.google.Chrome";
  assert.equal(categoryOf(chrome, { urlHost: "mail.google.com" }), "email");
  assert.equal(categoryOf(chrome, { urlHost: "outlook.office.com" }), "email");
  assert.equal(categoryOf(chrome, { urlHost: "app.slack.com" }), "work");
  assert.equal(categoryOf(chrome, { urlHost: "openwhispr.slack.com" }), "work");
  assert.equal(categoryOf(chrome, { urlHost: "www.linkedin.com" }), "work");
  assert.equal(categoryOf(chrome, { urlHost: "web.whatsapp.com" }), "personal");
  assert.equal(categoryOf(chrome, { urlHost: "x.com" }), "personal");
  assert.equal(categoryOf(chrome, { urlHost: "github.com" }), "other");
  assert.equal(categoryOf(chrome, { urlHost: "notslack.com" }), "other");
});

test("a host that names no app leaves it to a site name the host carries", () => {
  const safari = "Safari com.apple.Safari";
  assert.equal(
    categoryOf(safari, { urlHost: "www.icloud.com", windowTitle: "iCloud Mail" }),
    "email"
  );
  assert.equal(
    categoryOf(safari, { urlHost: "mail.yahoo.co.uk", windowTitle: "Inbox - Yahoo Mail" }),
    "email"
  );
  assert.equal(
    categoryOf(safari, { urlHost: "app.slack-gov.com", windowTitle: "general - Slack" }),
    "work"
  );
  // A page whose own title is a site name doesn't make its host that site.
  assert.equal(categoryOf(safari, { urlHost: "www.notion.so", windowTitle: "Hey" }), "other");
  assert.equal(categoryOf(safari, { urlHost: "www.notion.so", windowTitle: "Outlook" }), "other");
  assert.equal(
    categoryOf(safari, { urlHost: "mail.google.com", windowTitle: "Weekly report - Notion" }),
    "email"
  );
  assert.equal(
    categoryOf(safari, { urlHost: "docs.google.com", windowTitle: "Plan - Google Docs" }),
    "other"
  );
});

test("without a host, a browser is judged by the site name its title ends with", () => {
  const cases = [
    ["Google Chrome com.google.Chrome", "Inbox (3) - me@gmail.com - Gmail", "email"],
    [
      "Google Chrome com.google.Chrome",
      "Inbox - me@gmail.com - Gmail - Google Chrome – Saket (work.com)",
      "email",
    ],
    ["chrome.exe Chrome_WidgetWin_1", "Mail - Saket Sharma - Outlook - Google Chrome", "email"],
    [
      "msedge.exe Chrome_WidgetWin_1",
      "Gmail and 4 more pages - Work - Microsoft\u200b Edge",
      "email",
    ],
    ["firefox", "engineering (Channel) - OpenWhispr - Slack — Mozilla Firefox", "work"],
    ["Arc company.thebrowser.Browser", "(5) Feed | LinkedIn", "work"],
    ["Safari com.apple.Safari", "Chat | Saket | Microsoft Teams", "work"],
    ["brave.exe Chrome_WidgetWin_1", "(3) WhatsApp - Brave", "personal"],
    ["Safari com.apple.Safari", "Home / X", "personal"],
    ["msedge.exe Chrome_WidgetWin_1", "Inbox - me@gmail.com - Gmail - Microsoft Edge", "email"],
    ["microsoft-edge", "Inbox - Gmail - Microsoft Edge", "email"],
    ["librewolf", "Inbox - Gmail \u2014 LibreWolf", "email"],
    ["Google Chrome com.google.Chrome", "Slack pricing - Google Search", "other"],
    [
      "Google Chrome com.google.Chrome",
      "Outlook paste bug · Issue #12 · org/app - Google Chrome",
      "other",
    ],
    // A page whose own title is a bare site name is still that page.
    ["Google Chrome com.google.Chrome", "outlook - Google Search - Google Chrome", "other"],
    ["Google Chrome com.google.Chrome", "Slack - Google Docs - Google Chrome", "other"],
    ["Safari com.apple.Safari", "Pixies - Hey - YouTube", "other"],
    ["firefox", "Zoom - YouTube \u2014 Mozilla Firefox", "other"],
    // A browser's name inside the page title is part of the page, not its suffix.
    ["Google Chrome com.google.Chrome", "gmail - Brave Search - Google Chrome", "other"],
    ["brave.exe Chrome_WidgetWin_1", "slack - Brave Search - Brave", "other"],
    ["Safari com.apple.Safari", "slack - Brave Search", "other"],
    ["Google Chrome com.google.Chrome", "Discord - Opera forums - Google Chrome", "other"],
    ["firefox", "Inbox - Gmail \u2014 Mozilla Firefox Private Browsing", "email"],
  ];
  for (const [appSignature, windowTitle, category] of cases) {
    assert.equal(classifyToneAppCategory({ appSignature, windowTitle }), category, windowTitle);
  }
});

test("a Windows UWP app is named by its frame's title", () => {
  const frame = "ApplicationFrameHost.exe ApplicationFrameWindow";
  assert.equal(categoryOf(frame, { windowTitle: "WhatsApp" }), "personal");
  assert.equal(categoryOf(frame, { windowTitle: "Phone Link" }), "personal");
  assert.equal(categoryOf(frame, { windowTitle: "Calculator" }), "other");
});

test("a native app's title never changes its category", () => {
  assert.equal(
    categoryOf("Visual Studio Code com.microsoft.VSCode", { windowTitle: "notes - Gmail" }),
    "other"
  );
  assert.equal(categoryOf("Slack com.tinyspeck.slackmacgap", { windowTitle: "Gmail" }), "work");
});
