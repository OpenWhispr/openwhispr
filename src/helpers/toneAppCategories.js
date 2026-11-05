// What kind of writing a dictation is, judged from the app it goes into, so
// Tone & Style can apply the tone the user picked for it: "personal" messages,
// "work" messages, "email", or "other" for every app not listed here.
//
// App identities match by whole token or phrase, never bare substring, as in
// markdownTargets.js. The identity per platform:
//   macOS:   the app's name + bundle id ("Mail com.apple.mail"); the name is
//            localized (WeChat is 微信 on a Chinese system), so apps that
//            translate it are listed by their bundle id's token too
//   Windows: the exe name + window class ("OUTLOOK.EXE rctrl_renwnd32")
//   Linux:   the WM_CLASS or app id ("org.telegram.desktop")
// A browser is judged by its page instead: the host when macOS accessibility
// exposes the page URL and it's a listed site, otherwise the site name its
// window title ends with ("Inbox (3) - me@gmail.com - Gmail - Google Chrome").

const APP_SIGNATURES = {
  personal: [
    "whatsapp",
    "telegram",
    "telegramdesktop",
    "keepcoder",
    "messages",
    "mobilesms",
    "phoneexperiencehost",
    "signal",
    "messenger",
    "instagram",
    "facebook",
    "wechat",
    "weixin",
    "xinwechat",
    "naver.line",
    "line.exe",
    "viber",
    "kakaotalk",
    "kakaotalkmac",
    "discord",
    "beeper",
    "threema",
    "zalo",
  ],
  work: [
    "slack",
    "teams",
    "msteams",
    "teams-for-linux",
    "google chat",
    "linkedin",
    "mattermost",
    "rocket.chat",
    "rocketchat",
    "zulip",
    "webex",
    "zoom",
    "zoom.us",
    "lark",
    "feishu",
    "dingtalk",
    "dingtalkmac",
    "wxwork",
    "wecom",
    "weworkmac",
    "chanty",
    "flock",
    "pumble",
    "ringcentral",
  ],
  email: [
    "mail",
    "outlook",
    "olk",
    "hxoutlook",
    "gmail",
    "superhuman",
    "spark",
    "airmail",
    "thunderbird",
    "betterbird",
    "mimestream",
    "hey",
    "protonmail",
    "canarymail",
    "postbox",
    "em client",
    "mailclient",
    "mailspring",
    "evolution",
    "geary",
    "kmail",
    "kmail2",
    "bluemail",
    "missive",
    "shortwave",
    "tutanota",
  ],
};

const BROWSER_SIGNATURES = [
  "chrome",
  "chromium",
  "safari",
  "firefox",
  "msedge",
  "microsoft edge",
  "microsoft-edge",
  "arc",
  "brave",
  "opera",
  "vivaldi",
  "zen",
  "orion",
  "dia",
  "comet",
  "librewolf",
  "waterfox",
  "floorp",
  "thorium",
  "yandex",
  "duckduckgo",
  "sidekick",
];

// Hosts match exactly or as a parent domain ("app.slack.com" ends in "slack.com").
const SITE_HOSTS = {
  personal: [
    "whatsapp.com",
    "telegram.org",
    "instagram.com",
    "messenger.com",
    "facebook.com",
    "x.com",
    "twitter.com",
    "discord.com",
    "messages.google.com",
    "snapchat.com",
  ],
  work: [
    "slack.com",
    "teams.microsoft.com",
    "teams.live.com",
    "teams.cloud.microsoft",
    "chat.google.com",
    "linkedin.com",
    "zoom.us",
  ],
  email: [
    "mail.google.com",
    "outlook.live.com",
    "outlook.office.com",
    "outlook.office365.com",
    "outlook.cloud.microsoft",
    "mail.yahoo.com",
    "mail.proton.me",
    "app.fastmail.com",
    "mail.superhuman.com",
    "app.hey.com",
    "mail.zoho.com",
    "mail.aol.com",
    "app.tuta.com",
  ],
};

// The site name a page title ends with, compared whole after normalizing.
const SITE_TITLES = {
  personal: [
    "whatsapp",
    "whatsapp business",
    "telegram",
    "telegram web",
    "instagram",
    "messenger",
    "facebook",
    "x",
    "discord",
    "google messages",
    "messages for web",
    "phone link",
  ],
  work: ["slack", "microsoft teams", "google chat", "linkedin", "zoom"],
  email: [
    "gmail",
    "outlook",
    "yahoo mail",
    "proton mail",
    "fastmail",
    "superhuman",
    "hey",
    "zoho mail",
    "icloud mail",
  ],
};

const CATEGORIES = ["email", "work", "personal"];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const tokenPattern = (entry) => new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(entry)}(?:$|[^a-z0-9])`);

const APP_PATTERNS = Object.fromEntries(
  CATEGORIES.map((category) => [category, APP_SIGNATURES[category].map(tokenPattern)])
);
// Apps judged by their window title rather than their own identity: browsers,
// and on Windows the frame host every UWP app (WhatsApp, Phone Link) runs in,
// whose title is the app's name.
const TITLE_JUDGED_PATTERNS = [...BROWSER_SIGNATURES, "applicationframehost"].map(tokenPattern);

// Every Chromium and Electron window on Windows has this class, so "chrome"
// inside it says nothing about the app.
const CHROMIUM_WINDOW_CLASS = /chrome_widgetwin_\d+/g;

// A title segment that is the browser's own name, as a whole segment, so a
// page such as "gmail - Brave Search" keeps its words.
const BROWSER_TITLE_NAME =
  /^(?:google chrome|chromium|microsoft edge|mozilla firefox|firefox|librewolf|waterfox|floorp|zen browser|brave|opera|vivaldi|thorium|yandex)(?: private browsing| \(.*\))?$/;
const TITLE_SEPARATOR = /\s[-\u2013\u2014|\u00b7\u2022/]\s/;
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;

function normalizeSignature(appSignature) {
  return String(appSignature || "")
    .toLowerCase()
    .replace(CHROMIUM_WINDOW_CLASS, " ");
}

function matchApp(signature) {
  return CATEGORIES.find((category) =>
    APP_PATTERNS[category].some((pattern) => pattern.test(signature))
  );
}

// The browser's name ends the title, or comes just before the profile Chrome
// on macOS appends after it.
function withoutBrowserName(segments) {
  const last = segments.length - 1;
  if (BROWSER_TITLE_NAME.test(segments[last])) return segments.slice(0, last);
  if (last > 0 && BROWSER_TITLE_NAME.test(segments[last - 1])) return segments.slice(0, last - 1);
  return segments;
}

function matchHost(urlHost) {
  const host = urlHost.toLowerCase().replace(/^www\./, "");
  return CATEGORIES.find((category) =>
    SITE_HOSTS[category].some((site) => host === site || host.endsWith(`.${site}`))
  );
}

// Whether a host carries a site name's brand, its first word, as a label:
// "icloud mail" on www.icloud.com, "yahoo mail" on mail.yahoo.co.uk.
function hostCarriesSite(urlHost, siteName) {
  return urlHost.toLowerCase().split(/[.-]/).includes(siteName.split(" ")[0]);
}

// The site name is the last segment of the page title; Edge may put a profile
// name after it, so there the segment before counts too. Whole-segment
// equality keeps a page that merely mentions a site name out.
function matchTitle(windowTitle, accepts = () => true) {
  const title = windowTitle.toLowerCase().replace(ZERO_WIDTH, "");
  const candidates = withoutBrowserName(
    title.split(TITLE_SEPARATOR).map((segment) => segment.trim())
  )
    .slice(title.endsWith("microsoft edge") ? -2 : -1)
    .map((segment) =>
      segment
        .replace(/^\(\d+\+?\)\s*/, "")
        .replace(/\sand \d+ more (?:pages?|tabs?)$/, "")
        .trim()
    );
  return (
    CATEGORIES.find((category) =>
      candidates.some((segment) => SITE_TITLES[category].includes(segment) && accepts(segment))
    ) ?? "other"
  );
}

/**
 * @param {{ appSignature?: string, windowTitle?: string, urlHost?: string } | null} context
 * @returns {"personal" | "work" | "email" | "other"}
 */
function classifyToneAppCategory(context) {
  if (!context) return "other";
  const signature = normalizeSignature(context.appSignature);
  const app = matchApp(signature);
  if (app) return app;
  if (!TITLE_JUDGED_PATTERNS.some((pattern) => pattern.test(signature))) return "other";
  const byHost = context.urlHost && matchHost(context.urlHost);
  if (byHost) return byHost;
  if (!context.windowTitle) return "other";
  // A host not listed here (iCloud Mail is www.icloud.com) leaves it to the
  // title, but only to a site name the host itself carries: a Notion page
  // titled "Hey" or "Outlook" stays other.
  return matchTitle(
    context.windowTitle,
    (siteName) => !context.urlHost || hostCarriesSite(context.urlHost, siteName)
  );
}

module.exports = { classifyToneAppCategory };
