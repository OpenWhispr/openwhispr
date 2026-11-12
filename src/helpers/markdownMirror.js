const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { WINDOWS_RESERVED_NAME } = require("./windowsReservedName");
const { renameWithRetry } = require("./renameWithRetry");

// Most file systems allow 255 bytes per name; this leaves room for the suffix.
const MAX_FOLDER_NAME_BYTES = 120;
const UNSAFE_NAME_CHARACTER = /[<>:"/\\|?*\u0000-\u001f]/;
const UNSAFE_NAME_CHARACTERS = new RegExp(UNSAFE_NAME_CHARACTER.source, "g");
// What a name made safe ends with, so a name typed that way is made safe too
// and can never land on another's directory.
const SAFE_NAME_SUFFIX = / \([0-9a-f]{8}\)$/i;
// Leaves room in a 255-byte file name for the note id, "-transcript.md" and a
// temporary file's suffix.
const MAX_SLUG_BYTES = 150;

const SYSTEM_LEFTOVERS = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const OLD_FRONTMATTER_LINE = /^(id|title|type|folder|created|updated):/;

const normalizeText = (text) =>
  text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trimEnd();
// A re-save that only changes line endings or adds a BOM isn't an edit.
const normalizeLineEndings = (text) => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
const hashOf = (content) => crypto.createHash("sha256").update(content, "utf8").digest("hex");

// A control character (newline, carriage return, tab) in a title splits the
// mapping onto a bare line and makes the whole frontmatter block unparseable,
// so force quoting and escape them like `"` and `\` — keeping the value on one
// line and round-tripping back to the original when parsed.
function escYaml(str) {
  if (!str) return '""';
  if (
    /[:#{}[\],&*?|>!%@`]/.test(str) ||
    /[\n\r\t]/.test(str) ||
    str.includes('"') ||
    str.includes("'")
  ) {
    return `"${str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")}"`;
  }
  return str;
}

// The frontmatter block as key → raw value, or null when there isn't one.
function parseFrontmatter(text) {
  const block = normalizeLineEndings(text).match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!block) return null;
  const values = new Map();
  for (const line of block[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    else if (line.trim()) values.set(line.trim(), null);
  }
  return { values, rest: normalizeLineEndings(text).slice(block[0].length) };
}

// Whether a file from the old layout still says exactly what the old mirror
// wrote for this note. Anything else, frontmatter a person added or changed
// included, may be the only copy of an outside edit. Its folder and updated
// lines aren't compared: they were the app's, and changed without the note.
function isUnchangedNoteFile(text, note) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return false;
  const expected = new Map([
    ["id", String(note.id)],
    ["title", escYaml(note.title)],
    ["type", note.note_type || "personal"],
  ]);
  if (note.created_at) expected.set("created", note.created_at);
  for (const [key, value] of parsed.values) {
    if (!OLD_FRONTMATTER_LINE.test(`${key}:`)) return false;
    if (expected.has(key) && expected.get(key).trim() !== value) return false;
  }
  const body = note.enhanced_content || note.content || "";
  return normalizeText(parsed.rest.replace(/^\n/, "")) === normalizeText(body);
}

// Stands in for the database's record when the mirror runs on its own.
function createMemoryLedger() {
  const entries = new Map();
  const keyOf = (basePath, relPath) => `${basePath}\0${relPath}`;
  return {
    files: (basePath) => [...entries.values()].filter((entry) => entry.basePath === basePath),
    record: (basePath, entry) =>
      entries.set(keyOf(basePath, entry.relPath), { ...entry, basePath }),
    forget: (basePath, relPath) => entries.delete(keyOf(basePath, relPath)),
  };
}

// The mirror writes notes as Markdown and records each file it writes with a hash
// of what it wrote. It replaces or removes only a file it wrote that still holds
// exactly that; any other file in its way is renamed `edited-<name>` and left for
// good. So an outside edit, a file from before a database reset, or a file of the
// user's is never lost, whatever its name.
class MarkdownMirror {
  constructor() {
    this._basePath = null;
    this._baseRealPath = null;
    this._ledgerBasePath = null;
    this._ledger = createMemoryLedger();
    this._vacatedDirs = new Set();
    // Old-layout files by note id, read once and kept until the mirror moves.
    this._oldLayoutIndex = null;
    this._oldFolderNames = new Set(["Personal"]);
  }

  // { files(basePath, ownerId?), record(basePath, entry), forget(basePath, relPath) },
  // where an entry is { relPath, ownerId, kind: "note" | "transcript" | "dir", hash }
  // and ownerId is the note's id, or the folder's for a directory.
  setLedger(ledger) {
    this._ledger = ledger ?? createMemoryLedger();
  }

  init(basePath) {
    this._basePath = basePath;
    this._baseRealPath = null;
    this._ledgerBasePath = null;
    this._vacatedDirs.clear();
    this._oldLayoutIndex = null;
    this._oldFolderNames = new Set(["Personal"]);
    try {
      fs.mkdirSync(basePath, { recursive: true });
      // Keep existing ledger keys while using native spelling for filesystem safety.
      this._ledgerBasePath = fs.realpathSync(basePath);
      this._baseRealPath = fs.realpathSync.native(basePath);
      debugLogger.debug("Markdown mirror initialized", { basePath }, "note-files");
    } catch (err) {
      debugLogger.error("Failed to init markdown mirror", { error: err.message }, "note-files");
    }
  }

  getBasePath() {
    return this._basePath;
  }

  // A name no file system takes as is (a reserved name, unsafe characters, a
  // trailing dot or space, too long) keeps a readable form plus a short hash of
  // the original, so two names never share a directory.
  _safeFolderName(folderName) {
    const raw = String(folderName || "Personal");
    const needsChange =
      raw === "." ||
      raw === ".." ||
      raw.startsWith(" ") ||
      /[ .]$/.test(raw) ||
      Buffer.byteLength(raw, "utf8") > MAX_FOLDER_NAME_BYTES ||
      UNSAFE_NAME_CHARACTER.test(raw) ||
      WINDOWS_RESERVED_NAME.test(raw) ||
      SAFE_NAME_SUFFIX.test(raw);
    if (!needsChange) return raw;

    let readable = "";
    for (const character of raw.replace(UNSAFE_NAME_CHARACTERS, "-").replace(/^ +|[ .]+$/g, "")) {
      if (Buffer.byteLength(readable + character, "utf8") > MAX_FOLDER_NAME_BYTES) break;
      readable += character;
    }
    readable = readable.replace(/[ .]+$/, "");
    if (!readable || WINDOWS_RESERVED_NAME.test(readable)) readable = `_${readable}`;
    const digest = crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
    return `${readable} (${digest})`;
  }

  _isInsideBase(candidatePath) {
    if (!this._baseRealPath) return false;
    const relative = path.relative(this._baseRealPath, candidatePath);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }

  // A location is a placement ({ segments, workspace, space, folder }), or a bare
  // folder name for one directory directly under the base.
  _toLocation(location) {
    if (location && typeof location === "object") return location;
    const folder = location || "Personal";
    return { segments: [folder], folder };
  }

  _displayPath(canonicalPath) {
    const relative = path.relative(this._baseRealPath, canonicalPath);
    return path.join(this._basePath, relative);
  }

  _resolveExistingFolderPath(candidatePath) {
    if (!this._isInsideBase(candidatePath)) {
      throw new Error("Markdown mirror folder is outside the configured directory");
    }
    let current = this._baseRealPath;
    for (const segment of path.relative(this._baseRealPath, candidatePath).split(path.sep)) {
      current = path.join(current, segment);
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("Markdown mirror folder is not a regular directory");
      }
    }

    // The native resolver returns the stored spelling on case-insensitive disks.
    const realPath = fs.realpathSync.native(candidatePath);
    if (!this._isInsideBase(realPath)) {
      throw new Error("Markdown mirror folder resolves outside the configured directory");
    }
    return realPath;
  }

  // Each level is checked, so a directory that is a link out of the mirror is
  // never created in or written through.
  _resolveFolderPath(location, { create = false } = {}) {
    if (!this._baseRealPath) return null;
    let current = this._baseRealPath;
    for (const segment of this._toLocation(location).segments) {
      const candidatePath = path.join(current, this._safeFolderName(segment));
      if (!fs.existsSync(candidatePath)) {
        if (!create) return null;
        fs.mkdirSync(candidatePath);
      }
      current = this._resolveExistingFolderPath(candidatePath);
      if (create && path.basename(current) !== path.basename(candidatePath)) {
        const oldRelPath = this._relPath(current);
        renameWithRetry(current, candidatePath);
        current = candidatePath;
        const newRelPath = this._relPath(current);
        for (const entry of this.recordedFiles()) {
          if (entry.relPath === oldRelPath || entry.relPath.startsWith(`${oldRelPath}/`)) {
            this._ledger.forget(this._ledgerBasePath, entry.relPath);
            this._ledger.record(this._ledgerBasePath, {
              ...entry,
              relPath: newRelPath + entry.relPath.slice(oldRelPath.length),
            });
          }
        }
      }
    }
    return current;
  }

  _assertWritableFilePath(filePath) {
    this._resolveExistingFolderPath(path.dirname(filePath));
    // lstat, not exists: a dangling link reads as missing, and where opens follow links
    // (Windows has no O_NOFOLLOW) writing it would create the link's target.
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (stats && (stats.isSymbolicLink() || !stats.isFile())) {
      throw new Error("Markdown mirror file is not a regular file");
    }
  }

  // Cut by characters, not UTF-16 units: half an emoji would be stored as U+FFFD
  // and the recorded path would no longer match the file.
  _slugify(title) {
    const slug = (title || "Untitled")
      .toWellFormed()
      .replace(/[/\\?%*:|"<>]/g, "-")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
    let cut = "";
    for (const character of Array.from(slug).slice(0, 60)) {
      if (Buffer.byteLength(cut + character, "utf8") > MAX_SLUG_BYTES) break;
      cut += character;
    }
    return cut;
  }

  _buildFrontmatter(note, location) {
    const lines = [
      "---",
      `id: ${note.id}`,
      `title: ${escYaml(note.title)}`,
      `type: ${note.note_type || "personal"}`,
      ...(location.workspace ? [`workspace: ${JSON.stringify(location.workspace)}`] : []),
      ...(location.space ? [`space: ${JSON.stringify(location.space)}`] : []),
      ...(location.folder ? [`folder: ${escYaml(location.folder)}`] : []),
      `created: ${note.created_at || new Date().toISOString()}`,
      `updated: ${note.updated_at || new Date().toISOString()}`,
      "---",
    ];
    return lines.join("\n");
  }

  _relPath(absolutePath) {
    return path.relative(this._baseRealPath, absolutePath).split(path.sep).join("/");
  }

  _absolutePath(relPath) {
    return path.join(this._baseRealPath, ...relPath.split("/"));
  }

  // Where a note's file (or, for "dir", the location's directory) goes, without
  // touching the disk.
  relPathFor(note, location, kind) {
    const segments = this._toLocation(location).segments.map((name) => this._safeFolderName(name));
    if (kind === "dir") return segments.join("/");
    const suffix = kind === "transcript" ? "-transcript.md" : ".md";
    return [...segments, `${note.id}-${this._slugify(note.title)}${suffix}`].join("/");
  }

  recordedFiles() {
    if (!this._baseRealPath) return [];
    return this._ledger.files(this._ledgerBasePath);
  }

  _recorded(noteId, kind) {
    return this._ledger
      .files(this._ledgerBasePath, noteId)
      .filter((entry) => entry.ownerId === noteId && entry.kind === kind);
  }

  _isPristine(entry) {
    try {
      const filePath = this._absolutePath(entry.relPath);
      this._assertWritableFilePath(filePath);
      const stats = fs.lstatSync(filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) return false;
      const text = fs.readFileSync(filePath, "utf-8");
      return hashOf(text) === entry.hash || hashOf(normalizeLineEndings(text)) === entry.hash;
    } catch {
      return false;
    }
  }

  // A name that differs only in case or Unicode form can be the same file, which
  // removing the "other" path would delete. Only the file system can say; where
  // it reports no file ids, names that fold together count as the same file.
  _isSameFile(leftPath, rightPath) {
    try {
      const left = fs.statSync(leftPath, { bigint: true });
      const right = fs.statSync(rightPath, { bigint: true });
      if (left.ino !== 0n && right.ino !== 0n) {
        return left.dev === right.dev && left.ino === right.ino;
      }
    } catch {
      return false;
    }
    const fold = (filePath) => filePath.normalize("NFC").toLowerCase();
    return fold(leftPath) === fold(rightPath);
  }

  // In place, as the old mirror did: replacing the file on every save would give it a new
  // identity, which on macOS resets its creation date and drops its Finder tags. Only a file
  // the mirror owns, or none, is written here. One that fails partway gets its previous
  // content back, or goes if that fails too, rather than being kept aside as an edit.
  _writeInPlace(filePath, content, previousContent) {
    const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL, O_NOFOLLOW = 0 } = fs.constants;
    // Another process can recreate the path after an edited file was kept aside.
    const creationFlags = previousContent === null ? O_EXCL : O_TRUNC;
    const descriptor = fs.openSync(
      filePath,
      O_WRONLY | O_CREAT | creationFlags | O_NOFOLLOW,
      0o666
    );
    let failure = null;
    try {
      fs.writeFileSync(descriptor, content, "utf-8");
    } catch (err) {
      failure = err;
    }
    try {
      fs.closeSync(descriptor);
    } catch (err) {
      // A network disk can report a failed write only when the file closes.
      failure ??= err;
    }
    if (failure) {
      this._undoPartialWrite(filePath, previousContent);
      throw failure;
    }
  }

  _undoPartialWrite(filePath, previousContent) {
    try {
      if (previousContent === null) throw new Error("no previous content");
      fs.writeFileSync(filePath, previousContent, "utf-8");
    } catch {
      fs.rmSync(filePath, { force: true });
      this._ledger.forget(this._ledgerBasePath, this._relPath(filePath));
    }
  }

  _removeFile(filePath) {
    fs.unlinkSync(filePath);
    this._vacatedDirs.add(path.dirname(filePath));
  }

  // Renames a file the mirror mustn't replace, beside where it was, under a name
  // the mirror never reads.
  _keepAside(filePath) {
    const dirPath = path.dirname(filePath);
    const name = path.basename(filePath);
    let keptPath = path.join(dirPath, `edited-${name}`);
    for (let copy = 2; fs.lstatSync(keptPath, { throwIfNoEntry: false }); copy++) {
      keptPath = path.join(dirPath, `edited-${copy}-${name}`);
    }
    renameWithRetry(filePath, keptPath);
    this._ledger.forget(this._ledgerBasePath, this._relPath(filePath));
  }

  // A file this mirror wrote goes if it still holds what was written; otherwise
  // it's kept aside. Either way it stops being the note's.
  _releaseRecordedFile(entry) {
    const filePath = this._absolutePath(entry.relPath);
    try {
      if (!fs.existsSync(filePath)) {
        this._ledger.forget(this._ledgerBasePath, entry.relPath);
        return;
      }
      this._assertWritableFilePath(filePath);
      if (this._isPristine(entry)) {
        this._removeFile(filePath);
        this._ledger.forget(this._ledgerBasePath, entry.relPath);
      } else {
        this._keepAside(filePath);
      }
    } catch (err) {
      debugLogger.error(
        "Failed to remove a note file",
        { file: filePath, error: err.message },
        "note-files"
      );
    }
  }

  // A file from the old layout goes when it says exactly what the note says.
  _releaseOldFile(filePath, isUnchanged) {
    try {
      this._assertWritableFilePath(filePath);
      const text = fs.readFileSync(filePath, "utf-8");
      if (isUnchanged(filePath, text)) this._removeFile(filePath);
      else this._keepAside(filePath);
    } catch (err) {
      debugLogger.error(
        "Failed to move an old note file",
        { file: filePath, error: err.message },
        "note-files"
      );
    }
  }

  _writeNoteFile(noteId, kind, filePath, content, isUnchangedOld) {
    this._assertWritableFilePath(filePath);
    const relPath = this._relPath(filePath);
    const ownFiles = this._recorded(noteId, kind);
    let unchanged = false;
    let current = null;
    if (fs.existsSync(filePath)) {
      try {
        current = fs.readFileSync(filePath, "utf-8");
      } catch {}
      unchanged = current === content;
      const ownsIt = this._ledger
        .files(this._ledgerBasePath, noteId)
        .some(
          (entry) =>
            entry.ownerId === noteId &&
            entry.kind !== "dir" &&
            (entry.relPath === relPath ||
              this._isSameFile(this._absolutePath(entry.relPath), filePath)) &&
            this._isPristine(entry)
        );
      if (!unchanged && !ownsIt) {
        this._keepAside(filePath);
        current = null;
      }
    }
    // Identical content isn't rewritten, which keeps file-sync tools quiet.
    if (!unchanged) this._writeInPlace(filePath, content, current);
    this._ledger.record(this._ledgerBasePath, {
      relPath,
      ownerId: noteId,
      kind,
      hash: hashOf(content),
    });

    // Only now that the new file is in place does anything else go.
    for (const entry of ownFiles) {
      if (entry.relPath === relPath) continue;
      if (this._isSameFile(this._absolutePath(entry.relPath), filePath)) {
        this._ledger.forget(this._ledgerBasePath, entry.relPath);
      } else {
        this._releaseRecordedFile(entry);
      }
    }
    for (const oldPath of this._oldLayoutFiles(noteId, kind)) {
      if (!this._isSameFile(oldPath, filePath)) this._releaseOldFile(oldPath, isUnchangedOld);
    }
  }

  writeNote(note, location) {
    if (!this._baseRealPath) return;
    try {
      const target = this._toLocation(location);
      const dirPath = this._resolveFolderPath(target, { create: true });
      if (!dirPath) return;
      const body = note.enhanced_content || note.content || "";
      this._writeNoteFile(
        note.id,
        "note",
        path.join(dirPath, `${note.id}-${this._slugify(note.title)}.md`),
        `${this._buildFrontmatter(note, target)}\n\n${body}`,
        (_filePath, text) => isUnchangedNoteFile(text, note)
      );
    } catch (err) {
      debugLogger.error(
        "Failed to write note file",
        { noteId: note.id, error: err.message },
        "note-files"
      );
    }
  }

  // The one test of whether a note has a transcript to mirror. It matches
  // getMirrorNoteSummaries' has_transcript, or reconcile would rewrite the note
  // every time.
  transcriptSegments(note) {
    try {
      const segments = JSON.parse(note?.transcript || "[]");
      return Array.isArray(segments) ? segments : [];
    } catch {
      return [];
    }
  }

  // An old transcript went when it matches what the note's transcript would give in its
  // format; with no transcript in the database it's the only copy. Naming a speaker never
  // rewrote the old file, so each speaker line may carry today's name or the unnamed label
  // it was written with. Any other difference, a name typed in included, is an edit.
  _isUnchangedOldTranscript(note, speakerMappings) {
    const segments = this.transcriptSegments(note);
    return (filePath, text) => {
      if (!segments.length) return false;
      const { formatMd, formatTxt } = require("./transcriptFormatter");
      const format = filePath.endsWith(".txt") ? formatTxt : formatMd;
      const linesOf = (content) => normalizeText(content).split("\n");
      const named = linesOf(format(note, segments, speakerMappings || {}));
      // Identifying a speaker writes the name into the segments, so the unnamed form
      // leaves those names out too.
      const unnamedSegments = segments.map(({ speakerName: _name, ...segment }) => segment);
      const unnamed = linesOf(format(note, unnamedSegments, {}));
      const lines = linesOf(text);
      const matches = (variant) => variant.join("\n") === lines.join("\n");
      // Line by line only when both forms have the same lines: unnamed segments can merge
      // into fewer turns.
      const mixed =
        named.length === unnamed.length &&
        lines.length === named.length &&
        lines.every((line, index) => line === named[index] || line === unnamed[index]);
      return matches(named) || matches(unnamed) || mixed;
    };
  }

  writeTranscript(note, location, speakerMappings) {
    if (!this._baseRealPath) return;
    try {
      const segments = this.transcriptSegments(note);
      if (!segments.length) return;
      const dirPath = this._resolveFolderPath(location, { create: true });
      if (!dirPath) return;
      const { formatMd } = require("./transcriptFormatter");
      this._writeNoteFile(
        note.id,
        "transcript",
        path.join(dirPath, `${note.id}-${this._slugify(note.title)}-transcript.md`),
        formatMd(note, segments, speakerMappings || {}),
        this._isUnchangedOldTranscript(note, speakerMappings)
      );
    } catch (err) {
      debugLogger.error(
        "Failed to write transcript file",
        { noteId: note.id, error: err.message },
        "note-files"
      );
    }
  }

  // For a note that no longer has a transcript.
  removeTranscripts(note, speakerMappings) {
    if (!this._baseRealPath) return;
    for (const entry of this._recorded(note.id, "transcript")) this._releaseRecordedFile(entry);
    const isUnchanged = this._isUnchangedOldTranscript(note, speakerMappings);
    for (const oldPath of this._oldLayoutFiles(note.id, "transcript")) {
      this._releaseOldFile(oldPath, isUnchanged);
    }
  }

  // With the note's row (a deleted note keeps one), old-layout files are checked
  // against it; without one they stay, since nothing shows they hold no more.
  deleteNote(noteId, note = null, speakerMappings = {}) {
    if (!this._baseRealPath) return;
    try {
      for (const kind of ["note", "transcript"]) {
        for (const entry of this._recorded(noteId, kind)) this._releaseRecordedFile(entry);
      }
      if (!note) return;
      for (const oldPath of this._oldLayoutFiles(noteId, "note")) {
        this._releaseOldFile(oldPath, (_filePath, text) => isUnchangedNoteFile(text, note));
      }
      const isUnchangedTranscript = this._isUnchangedOldTranscript(note, speakerMappings);
      for (const oldPath of this._oldLayoutFiles(noteId, "transcript")) {
        this._releaseOldFile(oldPath, isUnchangedTranscript);
      }
    } catch (err) {
      debugLogger.error("Failed to delete note file", { noteId, error: err.message }, "note-files");
    }
  }

  // Recorded with its folder, so it can follow a rename and go with a delete.
  ensureFolder(location, folderId = null) {
    if (!this._baseRealPath) return;
    try {
      const dirPath = this._resolveFolderPath(location, { create: true });
      if (dirPath && folderId != null) {
        this._ledger.record(this._ledgerBasePath, {
          relPath: this._relPath(dirPath),
          ownerId: folderId,
          kind: "dir",
          hash: null,
        });
      }
    } catch (err) {
      debugLogger.error("Failed to ensure folder", { error: err.message }, "note-files");
    }
  }

  // A recorded folder directory whose folder now belongs elsewhere. A rename
  // that only changes case is the same directory, so it's renamed in place.
  moveFolderDir(oldRelPath, location, folderId) {
    if (!this._baseRealPath) return;
    try {
      const oldPath = this._absolutePath(oldRelPath);
      const newPath = path.join(
        this._baseRealPath,
        ...this._toLocation(location).segments.map((name) => this._safeFolderName(name))
      );
      if (fs.existsSync(oldPath) && this._isSameFile(oldPath, newPath)) {
        this._resolveExistingFolderPath(oldPath);
        this._resolveFolderPath(location, { create: true });
        this.ensureFolder(location, folderId);
        if (oldRelPath !== this.relPathFor(null, location, "dir")) {
          this._ledger.forget(this._ledgerBasePath, oldRelPath);
        }
        return;
      }
    } catch (err) {
      debugLogger.debug(
        "Left a folder directory's case as it was",
        { error: err.message },
        "note-files"
      );
    }
    this.ensureFolder(location, folderId);
    this.releaseFolderDir(oldRelPath);
  }

  // A recorded folder directory that no longer belongs to its folder.
  releaseFolderDir(relPath) {
    if (!this._baseRealPath) return;
    this._ledger.forget(this._ledgerBasePath, relPath);
    this._vacatedDirs.add(this._absolutePath(relPath));
  }

  // System leftovers don't count as content, or a folder opened once in Finder
  // could never go away.
  _removeDirIfEmpty(dirPath) {
    const entries = fs.readdirSync(dirPath);
    if (!entries.every((name) => SYSTEM_LEFTOVERS.has(name))) return false;
    for (const name of entries) fs.rmSync(path.join(dirPath, name), { force: true });
    fs.rmdirSync(dirPath);
    return true;
  }

  // Directories files left, and their parents, while empty. A directory that is
  // a current folder's stays, even empty.
  removeVacatedDirs(keepRelPaths = new Set()) {
    if (!this._baseRealPath) return;
    const vacated = [...this._vacatedDirs];
    this._vacatedDirs.clear();
    for (const dirPath of vacated) {
      let relPath = this._relPath(dirPath);
      while (relPath && !relPath.startsWith("..") && !keepRelPaths.has(relPath)) {
        try {
          const resolved = this._resolveExistingFolderPath(this._absolutePath(relPath));
          if (keepRelPaths.has(this._relPath(resolved)) || !this._removeDirIfEmpty(resolved)) break;
        } catch {
          break;
        }
        relPath = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
      }
    }
  }

  // Old top-level directories that were an app folder and are now empty. An
  // empty directory with any other name is the user's.
  removeEmptyOldDirs(folderNames = []) {
    if (!this._baseRealPath) return;
    for (const name of new Set(folderNames)) {
      // The old mirror hashed a name it couldn't use as is to __ow-<sha256>.
      const oldEncoding = `__ow-${crypto.createHash("sha256").update(name, "utf8").digest("hex")}`;
      for (const dirName of [this._safeFolderName(name), oldEncoding]) {
        try {
          const dirPath = this._resolveExistingFolderPath(path.join(this._baseRealPath, dirName));
          this._removeDirIfEmpty(dirPath);
        } catch {}
      }
    }
  }

  // Ids that still have a file in the old <folder>/<id>-<slug>.md layout. Reads
  // the old layout afresh and keeps it for later writes, which then don't read
  // the user's folders again.
  legacyNoteIds(folderNames = []) {
    if (!this._baseRealPath) return new Set();
    this._oldFolderNames = new Set(
      ["Personal", ...folderNames]
        .flatMap((name) => [
          this._safeFolderName(name),
          `__ow-${crypto.createHash("sha256").update(name, "utf8").digest("hex")}`,
        ])
        .map((folderName) => {
          try {
            return path.basename(
              this._resolveExistingFolderPath(path.join(this._baseRealPath, folderName))
            );
          } catch {
            return folderName;
          }
        })
    );
    this._oldLayoutIndex = this._scanOldLayout();
    const ids = new Set();
    for (const [noteId, filePaths] of this._oldLayoutIndex) {
      if (filePaths.some((filePath) => this._fileKind(filePath))) ids.add(Number(noteId));
    }
    return ids;
  }

  getNotePath(noteId) {
    if (!this._baseRealPath) return null;
    const recorded = this._recorded(noteId, "note").find((entry) =>
      fs.existsSync(this._absolutePath(entry.relPath))
    );
    if (recorded) return this._displayPath(this._absolutePath(recorded.relPath));
    const [oldPath] = this._oldLayoutFiles(noteId, "note");
    return oldPath ? this._displayPath(oldPath) : null;
  }

  getFolderPath(location) {
    if (!this._baseRealPath) return null;
    try {
      const canonicalPath = this._resolveFolderPath(location);
      return canonicalPath ? this._displayPath(canonicalPath) : null;
    } catch {
      return null;
    }
  }

  // Note markdown opens with the frontmatter this mirror writes; transcript
  // companions open with "# <title>". BOM and CRLF are tolerated so a note an
  // external editor re-saved is still recognised.
  _isNoteMarkdownFile(filePath) {
    let fd;
    try {
      const stats = fs.lstatSync(filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) return false;
      fd = fs.openSync(filePath, "r");
      const marker = Buffer.alloc(8);
      const bytesRead = fs.readSync(fd, marker, 0, marker.length, 0);
      return /^\uFEFF?---\r?\n/.test(marker.toString("utf8", 0, bytesRead));
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // An id alone is common in a user's vault. Require the old mirror's metadata,
  // and exclude copies of the new layout, which always name their space.
  _namesItsNote(filePath, noteId) {
    try {
      const parsed = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
      return (
        parsed?.values.keys().next().value === "id" &&
        parsed.values.get("id") === noteId &&
        ["title", "type", "folder"].every((key) => parsed.values.has(key)) &&
        !parsed.values.has("space") &&
        !parsed.values.has("workspace")
      );
    } catch {
      return false;
    }
  }

  // A transcript opens as transcriptFormatter wrote it: "# <title>" then the
  // date in Markdown, or the title, the date and a rule line in text.
  _looksLikeTranscript(filePath) {
    try {
      const lines = normalizeLineEndings(fs.readFileSync(filePath, "utf8")).split("\n", 6);
      return filePath.endsWith(".md")
        ? lines[0].startsWith("# ") && lines[2]?.startsWith("**")
        : lines.some((line) => /^─{10,}$/.test(line));
    } catch {
      return false;
    }
  }

  _fileKind(filePath) {
    const file = path.basename(filePath);
    const noteId = file.match(/^(\d+)-/)?.[1];
    if (!noteId) return null;
    try {
      this._assertWritableFilePath(filePath);
      const stats = fs.lstatSync(filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) return null;
    } catch {
      return null;
    }
    const isMarkdownNote = file.endsWith(".md") && this._isNoteMarkdownFile(filePath);
    if (file.endsWith("-transcript.txt") || (file.endsWith("-transcript.md") && !isMarkdownNote)) {
      const knownFolder = this._oldFolderNames.has(path.basename(path.dirname(filePath)));
      return knownFolder && this._looksLikeTranscript(filePath) ? "transcript" : null;
    }
    return isMarkdownNote && this._namesItsNote(filePath, noteId) ? "note" : null;
  }

  // Files one level inside each top-level directory, as the old layout put them,
  // that the mirror hasn't recorded, by note id. Dot directories are scanned
  // only when the database names them as app folders, protecting tool directories.
  _scanOldLayout() {
    const recorded = new Set(this.recordedFiles().map((entry) => entry.relPath));
    const index = new Map();
    try {
      for (const entry of fs.readdirSync(this._baseRealPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") && !this._oldFolderNames.has(entry.name)) continue;
        let dirPath;
        try {
          dirPath = this._resolveExistingFolderPath(path.join(this._baseRealPath, entry.name));
        } catch {
          continue;
        }
        for (const file of fs.readdirSync(dirPath)) {
          const noteId = file.match(/^(\d+)-/)?.[1];
          const filePath = path.join(dirPath, file);
          if (!noteId || recorded.has(this._relPath(filePath))) continue;
          // A folder renamed while the mirror was off is no longer in the database.
          // Its legacy note header also identifies where its transcript companions lived.
          if (
            file.endsWith(".md") &&
            this._isNoteMarkdownFile(filePath) &&
            this._namesItsNote(filePath, noteId)
          ) {
            this._oldFolderNames.add(entry.name);
          }
          if (!index.has(noteId)) index.set(noteId, []);
          index.get(noteId).push(filePath);
        }
      }
    } catch {}
    return index;
  }

  _oldLayoutFiles(noteId, kind) {
    if (!this._baseRealPath) return [];
    this._oldLayoutIndex ??= this._scanOldLayout();
    return (this._oldLayoutIndex.get(String(noteId)) ?? []).filter(
      (filePath) => fs.existsSync(filePath) && this._fileKind(filePath) === kind
    );
  }
}

module.exports = new MarkdownMirror();
