// Apps whose text surface wants markdown left alone: markdown-native editors,
// apps that convert pasted markdown into formatting, chat tools whose composer
// is standard markdown, AI prompt boxes (a model reads markdown happily) and
// code editors / IDEs (nothing renders formatting there, and a developer's
// backticks and fences are deliberate). Anything not listed gets plain text —
// the safe default, because a wrong verdict here pastes literal asterisks
// into someone's document.
//
// Matching is by whole token or phrase, never bare substring, so "code" does
// not match "Xcode". Entries are lowercase and never a generic word another
// app could carry: "riot" (Element's Flatpak id) would match the Riot Games
// launcher and "remarkable" (a small Linux editor) the reMarkable tablet app,
// so neither is here. The identity matched per platform:
//   macOS   — the .app folder name + executable resolved from the pid
//             ("Visual Studio Code Code"), plus the copy helper's app name
//   Windows — the exe name ("Code.exe", "idea64.exe") + window class
//   Linux   — the WM_CLASS ("code", "md.obsidian.obsidian", "jetbrains-idea")
// Evidence per app, and the apps deliberately excluded:
// docs/superpowers/specs/2026-09-10-agent-paste-plain-text-design.md, Appendix A–C.

const MARKDOWN_TARGET_SIGNATURES = [
  // Markdown-native note editors — the file is markdown.
  "obsidian",
  "typora",
  "logseq",
  "joplin",
  "zettlr",
  "ia writer",
  "ulysses",
  "simplenote",
  "inkdrop",
  "marktext",
  "noteplan",
  "drafts",
  "macdown",
  "markedit",
  "nota",
  "byword",
  "fsnotes",
  "the archive",
  "qownnotes",
  "boost note",
  "boostnote",
  "notable",
  "supernotes",
  "heynote",
  "apostrophe",
  "ghostwriter",
  "abricotine",
  // Apps that convert pasted markdown into formatting (vendor-documented).
  "notion",
  "evernote",
  "notesnook",
  "workflowy",
  "bear",
  "craft",
  "remnote",
  "anytype",
  "siyuan",
  "capacities",
  "reflect",
  "heptabase",
  "roam",
  "appflowy",
  // Chat composers that are standard markdown (not Slack, Teams, WhatsApp or
  // Telegram — their dialects turn **bold** into stray asterisks).
  "discord",
  "zulip",
  "mattermost",
  "element",
  "rocket.chat",
  "rocketchat",
  // Work tools whose long-text fields convert pasted markdown.
  "linear",
  "todoist",
  "ticktick",
  "trello",
  // AI prompt boxes — the model reads markdown.
  "chatgpt",
  "claude",
  "gemini",
  "perplexity",
  "copilot",
  "m365copilot",
  "poe",
  "lm studio",
  "lm-studio",
  "ollama",
  "jan",
  "msty",
  "chatbox",
  "boltai",
  "cherry studio",
  "cherry-studio",
  "anythingllm",
  "anythingllmdesktop",
  "witsy",
  "gpt4all",
  // Code editors and IDEs — nothing renders formatting; the AI chat panels
  // inside them are prompt boxes. Not general prose editors (TextEdit,
  // Notepad, gedit): those are the plain-text case.
  "visual studio code",
  "code",
  "vscodium",
  "codium",
  "cursor",
  "windsurf",
  "devin",
  "zed",
  "trae",
  "kiro",
  "antigravity",
  "void",
  "positron",
  "pearai",
  "aide",
  "intellij",
  "idea",
  "idea64",
  "pycharm",
  "pycharm64",
  "webstorm",
  "webstorm64",
  "phpstorm",
  "phpstorm64",
  "rider",
  "rider64",
  "goland",
  "goland64",
  "clion",
  "clion64",
  "rubymine",
  "rubymine64",
  "datagrip",
  "datagrip64",
  "android studio",
  "studio64",
  "jetbrains",
  "sublime",
  "sublime_text",
  "subl",
  "nova",
  "bbedit",
  "coteditor",
  "kate",
  "notepad++",
  "emacs",
  "runemacs",
  "macvim",
  "gvim",
  "neovide",
  "devenv",
];

// Checked first, as plain substrings. An app that carries a listed name but
// is not a markdown surface — the veto wins.
const MARKDOWN_TARGET_VETOES = ["notion calendar", "notion mail", "xcode"];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole-token / whole-phrase match: the entry must be bounded on both sides by
// the start or end of the signature or by a character that is not a letter or
// digit. Dots, hyphens, underscores and spaces all count as boundaries, which
// is what makes "md.obsidian.obsidian", "jetbrains-idea" and "Code.exe" match
// while "Xcode" does not.
const TOKEN_PATTERNS = MARKDOWN_TARGET_SIGNATURES.map(
  (entry) => new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(entry)}(?:$|[^a-z0-9])`)
);

function isMarkdownTargetSignature(signature) {
  if (!signature) return false;
  const normalized = String(signature).toLowerCase();
  if (MARKDOWN_TARGET_VETOES.some((veto) => normalized.includes(veto))) return false;
  return TOKEN_PATTERNS.some((pattern) => pattern.test(normalized));
}

module.exports = {
  MARKDOWN_TARGET_SIGNATURES,
  MARKDOWN_TARGET_VETOES,
  isMarkdownTargetSignature,
};
