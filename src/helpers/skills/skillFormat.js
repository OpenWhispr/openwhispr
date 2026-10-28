const crypto = require("crypto");
const path = require("path");
const yaml = require("js-yaml");
const { WINDOWS_RESERVED_NAME } = require("../windowsReservedName");

// The Agent Skills format (agentskills.io): a folder holding SKILL.md, whose
// header block carries a name and a description.
const SKILL_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxFiles: 500,
  nameMax: 64,
  descriptionMax: 1024,
  warnDescription: 300,
  warnBodyLines: 500,
};
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ALLOWED_TOP_LEVEL_KEYS = [
  "name",
  "description",
  "license",
  "compatibility",
  "allowed-tools",
  "metadata",
];
const RESERVED_NAME_WORDS = ["claude", "anthropic"];
const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".rb",
  ".pl",
  ".applescript",
]);
const PLACEHOLDER = "[TODO:";
const TEXT_SNIFF_BYTES = 8192;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function normalizeLineEndings(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

// Agent Skills header: "---" on the first line, closed by "---" (or "...") on its own line.
function splitFrontmatter(text) {
  if (!text.startsWith("---\n")) return { header: null, body: text };
  const close = /\n(?:---|\.\.\.)[ \t]*(?:\n|$)/g;
  close.lastIndex = 3;
  const match = close.exec(text);
  if (!match) return { header: null, body: text };
  return {
    header: text.slice(4, match.index),
    body: text.slice(match.index + match[0].length).replace(/^\n+/, ""),
  };
}

function characterCount(text) {
  return [...text].length;
}

function lineCount(text) {
  return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
}

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function fieldProblems(data) {
  const problems = [];
  const { name } = data;
  if (!trimmedString(name)) problems.push({ code: "missingName" });
  else if (!SKILL_NAME_PATTERN.test(name)) problems.push({ code: "nameFormat" });
  else if (name.length > SKILL_LIMITS.nameMax) problems.push({ code: "nameTooLong" });
  // The name is the skill's folder name, so a skill named this way couldn't move to Windows.
  else if (WINDOWS_RESERVED_NAME.test(name)) problems.push({ code: "unsafePath" });

  const description = trimmedString(data.description);
  if (!description) {
    problems.push({ code: "missingDescription" });
  } else {
    if (characterCount(description) > SKILL_LIMITS.descriptionMax) {
      problems.push({ code: "descriptionTooLong", values: { max: SKILL_LIMITS.descriptionMax } });
    }
    if (/[<>]/.test(description)) problems.push({ code: "descriptionAngleBrackets" });
  }
  return problems;
}

function fieldWarnings(data, body) {
  const warnings = [];
  const name = trimmedString(data.name).toLowerCase();
  if (RESERVED_NAME_WORDS.some((word) => name.includes(word))) {
    warnings.push({ code: "reservedWord" });
  }
  if (lineCount(body) > SKILL_LIMITS.warnBodyLines) warnings.push({ code: "longBody" });
  if (characterCount(trimmedString(data.description)) > SKILL_LIMITS.warnDescription) {
    warnings.push({ code: "longDescription" });
  }
  const unknownKeys = Object.keys(data).filter((key) => !ALLOWED_TOP_LEVEL_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    warnings.push({ code: "unknownKeys", values: { keys: unknownKeys.join(", ") } });
  }
  return warnings;
}

function parseSkillMarkdown(raw) {
  const text = normalizeLineEndings(raw);
  const { header, body } = splitFrontmatter(text);
  if (header === null) {
    return { data: null, body, problems: [{ code: "frontmatterMissing" }], warnings: [] };
  }
  let data;
  try {
    // CORE_SCHEMA: plain YAML types only. js-yaml 4 throws on duplicate keys.
    data = yaml.load(header, { schema: yaml.CORE_SCHEMA });
  } catch {
    return { data: null, body, problems: [{ code: "frontmatterInvalid" }], warnings: [] };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { data: null, body, problems: [{ code: "frontmatterNotMapping" }], warnings: [] };
  }
  return { data, body, problems: fieldProblems(data), warnings: fieldWarnings(data, body) };
}

function displayNameFor(name, metadata) {
  const custom =
    metadata && typeof metadata === "object" ? trimmedString(metadata.display_name) : "";
  if (custom) return custom;
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isTextFile(data) {
  if (data.subarray(0, TEXT_SNIFF_BYTES).includes(0)) return false;
  try {
    utf8.decode(data);
    return true;
  } catch {
    return false;
  }
}

function isScriptPath(relPath) {
  const lower = relPath.toLowerCase();
  return lower.startsWith("scripts/") || SCRIPT_EXTENSIONS.has(path.posix.extname(lower));
}

/**
 * Checks a skill's files, given relative to its root with SKILL.md at "SKILL.md".
 * `source` is where they come from: an upload, a folder already on disk, or the app itself.
 */
function validateSkillFiles(files, { folderName, source }) {
  const skillFile = files.find((entry) => entry.path === "SKILL.md");
  const refused = (code) => ({ data: null, problems: [{ code }], warnings: [] });
  // Read as UTF-8 and copied back out exactly as stored, so it must be UTF-8 text.
  const parsed = !skillFile
    ? refused("noSkillFile")
    : isTextFile(skillFile.data)
      ? parseSkillMarkdown(skillFile.data.toString("utf8"))
      : refused("skillFileNotUtf8");
  const name = typeof parsed.data?.name === "string" ? parsed.data.name : "";
  const problems = [...parsed.problems];
  const warnings = [];

  if (name && folderName && folderName !== name) {
    if (source === "disk") problems.push({ code: "nameMismatch" });
    if (source === "upload") warnings.push({ code: "folderRenamed" });
  }
  // The instructions only: a file the person attaches may hold a [TODO: of its own.
  if (source === "app" && parsed.body?.includes(PLACEHOLDER)) {
    problems.push({ code: "placeholder" });
  }

  // A folder on disk is the skill's identity; an upload is stored under its name.
  const shownName = source === "disk" ? folderName : name || folderName;
  return {
    name,
    displayName: shownName ? displayNameFor(shownName, parsed.data?.metadata) : "",
    description: trimmedString(parsed.data?.description),
    problems,
    warnings: [...warnings, ...parsed.warnings],
  };
}

function trimHyphens(text) {
  return text.replace(/^-+|-+$/g, "");
}

function slugifySkillName(title, taken) {
  const slug = trimHyphens(
    trimHyphens(
      String(title)
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
    ).slice(0, SKILL_LIMITS.nameMax)
  );
  const base = slug || "skill";
  const usable = (candidate) => !taken.has(candidate) && !WINDOWS_RESERVED_NAME.test(candidate);
  if (usable(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const ending = `-${suffix}`;
    const candidate = `${trimHyphens(base.slice(0, SKILL_LIMITS.nameMax - ending.length))}${ending}`;
    if (usable(candidate)) return candidate;
  }
}

// JSON strings are valid YAML double-quoted scalars, so any text survives the header.
function buildSkillMarkdown({ name, title, description, instructions }) {
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description.trim())}`,
    "metadata:",
    `  display_name: ${JSON.stringify(title.trim())}`,
    "---",
    "",
    instructions.trim(),
    "",
  ].join("\n");
}

function contentHash(files) {
  const hash = crypto.createHash("sha256");
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.data);
    hash.update("\0");
  }
  return hash.digest("hex");
}

module.exports = {
  SKILL_LIMITS,
  SKILL_NAME_PATTERN,
  parseSkillMarkdown,
  validateSkillFiles,
  displayNameFor,
  slugifySkillName,
  buildSkillMarkdown,
  isTextFile,
  isScriptPath,
  contentHash,
};
