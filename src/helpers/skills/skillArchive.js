const zlib = require("zlib");
const unzipper = require("unzipper");
const { WINDOWS_RESERVED_NAME } = require("../windowsReservedName");
const { SKILL_LIMITS } = require("./skillFormat");

const SKILL_FILE_NAME = "skill.md";
const END_RECORD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const END_RECORD_SIZE = 22;
// The end record is followed by a comment of up to 64 KB.
const MAX_TAIL = END_RECORD_SIZE + 0xffff;
// Folders and macOS metadata are entries too, so the listing may run past the file cap.
const ENTRIES_PER_FILE = 4;

// Where the end record sits and how many entries it claims, read before the archive is
// opened: the reader takes a step per claimed entry, so a forged count would exhaust memory.
// A field at its largest value sends the reader to a zip64 record instead, whose count can
// be far larger; a skill never needs zip64, so such an archive isn't opened at all.
function readEndRecord(buffer) {
  if (buffer.length < END_RECORD_SIZE) return null;
  const at = buffer.lastIndexOf(END_RECORD, buffer.length - END_RECORD_SIZE);
  if (at < 0 || buffer.length - at > MAX_TAIL) return null;
  const entries = buffer.readUInt16LE(at + 10);
  const usesZip64 =
    buffer.readUInt16LE(at + 4) === 0xffff ||
    entries === 0xffff ||
    buffer.readUInt32LE(at + 16) === 0xffffffff;
  return usesZip64 ? null : { entries, tailSize: buffer.length - at };
}

function isSafeArchivePath(raw) {
  if (/[\u0000-\u001f]/.test(raw) || raw.includes("\\")) return false;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return false;
  return raw
    .replace(/^\.\//, "")
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !/[<>:"|?*]/.test(segment) &&
        !/[ .]$/.test(segment) &&
        !WINDOWS_RESERVED_NAME.test(segment)
    );
}

function isJunk(entryPath) {
  return entryPath.startsWith("__MACOSX/") || entryPath.split("/").pop() === ".DS_Store";
}

function isSymlinkEntry(entry) {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

// A size of 0xffffffff sends the reader to the entry's zip64 field. Without one the entry has
// no size, and the reader would read it on to the end of the file.
function hasSizes(entry) {
  return Number.isFinite(entry.compressedSize) && Number.isFinite(entry.uncompressedSize);
}

// Paths a case-insensitive disk would write to the same place, or a file where a folder goes.
function hasClashingPaths(paths) {
  const files = new Set();
  const folders = new Set();
  for (const entryPath of paths) {
    const key = entryPath.normalize("NFC").toLowerCase();
    if (files.has(key)) return true;
    files.add(key);
    const segments = key.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      folders.add(segments.slice(0, depth).join("/"));
    }
  }
  return [...files].some((key) => folders.has(key));
}

// The central directory's sizes and checksums can lie, so the cap counts the bytes actually
// read and the checksum is checked against them.
async function readCapped(entry, budget) {
  const chunks = [];
  let size = 0;
  for await (const chunk of entry.stream()) {
    size += chunk.length;
    // Leaving the loop destroys the stream, so nothing past the cap is inflated.
    if (size > budget.remaining) throw Object.assign(new Error("tooLarge"), { code: "tooLarge" });
    chunks.push(chunk);
  }
  budget.remaining -= size;
  const data = Buffer.concat(chunks);
  if (zlib.crc32(data) !== entry.crc32) throw new Error("The entry's checksum doesn't match");
  return data;
}

function refuse(code) {
  return { files: [], rootFolder: null, problems: [{ code }] };
}

/**
 * Reads a .zip or .skill archive into a skill's files, relative to the skill root with
 * SKILL.md at "SKILL.md". Every entry is checked from the listing before any is read.
 */
async function readSkillArchive(buffer, { limits: overrides } = {}) {
  const limits = { ...SKILL_LIMITS, ...overrides };
  const end = readEndRecord(buffer);
  if (!end) return refuse("unreadableArchive");
  if (end.entries > limits.maxFiles * ENTRIES_PER_FILE) return refuse("tooManyFiles");
  let directory;
  try {
    directory = await unzipper.Open.buffer(buffer, { tailSize: end.tailSize });
  } catch {
    return refuse("unreadableArchive");
  }

  const entries = directory.files.filter(
    (entry) => entry.type !== "Directory" && !isJunk(entry.path)
  );
  if (!entries.every(hasSizes)) return refuse("unreadableArchive");
  // Each entry is inflated from its own stretch of the file, so entries that point at the
  // same bytes would inflate them again and again.
  const compressedBytes = entries.reduce((total, entry) => total + entry.compressedSize, 0);
  if (compressedBytes > buffer.length) return refuse("unreadableArchive");
  if (entries.some((entry) => !isSafeArchivePath(entry.path))) return refuse("unsafePath");
  if (entries.some(isSymlinkEntry)) return refuse("symlink");
  const paths = entries.map((entry) => entry.path.replace(/^\.\//, ""));
  if (hasClashingPaths(paths)) return refuse("unsafePath");
  if (entries.length > limits.maxFiles) return refuse("tooManyFiles");

  const skillFiles = paths.filter(
    (entryPath) => entryPath.split("/").pop().toLowerCase() === SKILL_FILE_NAME
  );
  if (skillFiles.length === 0) return refuse("noSkillFile");
  if (skillFiles.length > 1) return refuse("multipleSkillFiles");
  const skillSegments = skillFiles[0].split("/");
  if (skillSegments.length > 2) return refuse("skillFileTooDeep");
  const rootFolder = skillSegments.length === 2 ? skillSegments[0] : null;
  if (rootFolder && paths.some((entryPath) => !entryPath.startsWith(`${rootFolder}/`))) {
    return refuse("skillFileTooDeep");
  }
  const declaredBytes = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (declaredBytes > limits.maxBytes) return refuse("tooLarge");

  const budget = { remaining: limits.maxBytes };
  const files = [];
  try {
    for (const [index, entry] of entries.entries()) {
      const entryPath = paths[index];
      const relative = rootFolder ? entryPath.slice(rootFolder.length + 1) : entryPath;
      const data = await readCapped(entry, budget);
      files.push({ path: entryPath === skillFiles[0] ? "SKILL.md" : relative, data });
    }
  } catch (error) {
    return refuse(error.code === "tooLarge" ? "tooLarge" : "unreadableArchive");
  }
  return { files, rootFolder, problems: [] };
}

module.exports = { readSkillArchive, isSafeArchivePath, hasClashingPaths };
