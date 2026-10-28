const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isMarkdownTargetSignature,
  MARKDOWN_TARGET_SIGNATURES,
} = require("../../src/helpers/markdownTargets");

// Each signature below is the exact shape one platform hands the matcher:
// macOS "<.app folder name> <executable>", Windows "<exe> <window class>",
// Linux "<WM_CLASS>". One representative per group of the spec's Appendix A.
test("markdown-friendly apps match on every platform's identity shape", () => {
  for (const signature of [
    "Obsidian Obsidian", // macOS, resolved from the pid
    "Visual Studio Code Code", // macOS: .app name and executable differ
    "IntelliJ IDEA idea", // macOS JetBrains
    "ChatGPT ChatGPT", // macOS AI prompt box
    "Google Gemini Gemini", // macOS, Chromium-path app name plus executable
    "Notion Notion",
    "Discord Discord",
    "Linear Linear",
    "Obsidian.exe Chrome_WidgetWin_1", // Windows exe + Electron window class
    "Code.exe Chrome_WidgetWin_1",
    "idea64.exe SunAwtFrame",
    "pycharm64.exe SunAwtFrame",
    "webstorm64.exe",
    "datagrip64.exe",
    "notepad++.exe Notepad++",
    "M365Copilot.exe",
    "md.obsidian.obsidian", // Linux Flatpak WM_CLASS
    "net.cozic.joplin_desktop",
    "jetbrains-idea",
    "dev.zed.zed",
    "code",
    "org.kde.kate",
  ]) {
    assert.equal(isMarkdownTargetSignature(signature), true, signature);
  }
});

test("plain-text apps, own-dialect chat tools, browsers and near-miss names never match", () => {
  for (const signature of [
    "TextEdit TextEdit",
    "Notes Notes",
    "Microsoft Word Microsoft Word",
    "Pages Pages",
    "Mail Mail",
    "WINWORD.EXE",
    "notepad.exe Notepad",
    "gedit",
    "Slack Slack",
    "Microsoft Teams MSTeams",
    "ms-teams.exe",
    "WhatsApp WhatsApp",
    "Telegram Telegram",
    "Xcode Xcode", // "code" must not match inside Xcode
    "Notion Calendar Notion Calendar", // veto
    "Notion Mail Notion Mail", // veto
    "Google Chrome Google Chrome",
    "Safari Safari",
    "Arc Arc",
    "Riot Client RiotClientUx.exe", // the reason "riot" is not an entry
    "reMarkable reMarkable", // the reason "remarkable" is not an entry
    "",
    null,
    undefined,
  ]) {
    assert.equal(isMarkdownTargetSignature(signature), false, String(signature));
  }
});

test("every entry is lowercase, at least three characters, and free of generic tokens", () => {
  for (const entry of MARKDOWN_TARGET_SIGNATURES) {
    assert.equal(entry, entry.toLowerCase(), entry);
    assert.ok(entry.length >= 3, entry);
  }
  for (const banned of ["riot", "remarkable", "notes", "mail", "word", "text", "app"]) {
    assert.ok(!MARKDOWN_TARGET_SIGNATURES.includes(banned), banned);
  }
});
