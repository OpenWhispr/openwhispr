const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { WINDOWS_RESERVED_NAME } = require("./windowsReservedName");

const ENCODED_FOLDER_PREFIX = "__ow-";

class MarkdownMirror {
  constructor() {
    this._basePath = null;
    this._baseRealPath = null;
    this._subfolderResolver = null;
  }

  // Supplies every subfolder on the device as [parent, name]: all the second
  // level of the mirror that belongs to the app. Without one, only top-level
  // directories are scanned for a note's files.
  setSubfolderResolver(resolver) {
    this._subfolderResolver = resolver;
  }

  init(basePath) {
    this._basePath = basePath;
    this._baseRealPath = null;
    try {
      fs.mkdirSync(basePath, { recursive: true });
      this._baseRealPath = fs.realpathSync(basePath);
      debugLogger.debug("Markdown mirror initialized", { basePath }, "note-files");
    } catch (err) {
      debugLogger.error("Failed to init markdown mirror", { error: err.message }, "note-files");
    }
  }

  getBasePath() {
    return this._basePath;
  }

  _safeFolderName(folderName) {
    const raw = String(folderName || "Personal");
    const requiresEncoding =
      raw === "." ||
      raw === ".." ||
      raw.startsWith(" ") ||
      /[ .]$/.test(raw) ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(raw) ||
      WINDOWS_RESERVED_NAME.test(raw) ||
      raw.toLowerCase().startsWith(ENCODED_FOLDER_PREFIX);
    if (!requiresEncoding) return raw;

    const digest = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
    return `${ENCODED_FOLDER_PREFIX}${digest}`;
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

  // A folder is its name, or [parent, name] for a subfolder, whose directory
  // sits inside its parent's.
  _folderCandidatePath(folderName) {
    if (!this._baseRealPath) return null;
    const segments = Array.isArray(folderName) ? folderName : [folderName];
    return path.join(this._baseRealPath, ...segments.map((name) => this._safeFolderName(name)));
  }

  _displayPath(canonicalPath) {
    const relative = path.relative(this._baseRealPath, canonicalPath);
    return path.join(this._basePath, relative);
  }

  _resolveExistingFolderPath(candidatePath) {
    const stats = fs.lstatSync(candidatePath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Markdown mirror folder is not a regular directory");
    }

    const realPath = fs.realpathSync(candidatePath);
    if (!this._isInsideBase(realPath)) {
      throw new Error("Markdown mirror folder resolves outside the configured directory");
    }
    return realPath;
  }

  _resolveFolderPath(folderName, { create = false } = {}) {
    // A subfolder's parent is checked first, so a parent directory that is a
    // link out of the mirror is never created in or written through.
    if (Array.isArray(folderName) && !this._resolveFolderPath(folderName[0], { create })) {
      return null;
    }
    const candidatePath = this._folderCandidatePath(folderName);
    if (!candidatePath) return null;

    if (!fs.existsSync(candidatePath)) {
      if (!create) return null;
      fs.mkdirSync(candidatePath, { recursive: true });
    }
    return this._resolveExistingFolderPath(candidatePath);
  }

  _assertWritableFilePath(filePath) {
    if (!fs.existsSync(filePath)) return;
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Markdown mirror file is not a regular file");
    }
  }

  _slugify(title) {
    return (title || "Untitled")
      .replace(/[/\\?%*:|"<>]/g, "-")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 60);
  }

  _buildFrontmatter(note, folderName) {
    const escYaml = (str) => {
      if (!str) return '""';
      // A control character (newline, carriage return, tab) in a title splits the
      // mapping onto a bare line and makes the whole frontmatter block unparseable,
      // so force quoting and escape them like `"` and `\` — keeping the value on
      // one line and round-tripping back to the original when parsed.
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
    };
    const lines = [
      "---",
      `id: ${note.id}`,
      `title: ${escYaml(note.title)}`,
      `type: ${note.note_type || "personal"}`,
      `folder: ${escYaml(folderName || "Personal")}`,
      `created: ${note.created_at || new Date().toISOString()}`,
      `updated: ${note.updated_at || new Date().toISOString()}`,
      "---",
    ];
    return lines.join("\n");
  }

  writeNote(note, folderName) {
    if (!this._baseRealPath) return;
    try {
      const dirPath = this._resolveFolderPath(folderName, { create: true });
      if (!dirPath) return;

      // Remove stale files (title changed or note moved to different folder)
      const glob = this._globNoteFiles(note.id);
      const slug = this._slugify(note.title);
      const newFileName = `${note.id}-${slug}.md`;
      const newFilePath = path.join(dirPath, newFileName);
      this._assertWritableFilePath(newFilePath);
      for (const existing of glob) {
        if (existing !== newFilePath) {
          try {
            fs.unlinkSync(existing);
          } catch {}
        }
      }

      const frontmatter = this._buildFrontmatter(
        note,
        [].concat(folderName || "Personal").join("/")
      );
      const body = note.enhanced_content || note.content || "";
      fs.writeFileSync(newFilePath, `${frontmatter}\n\n${body}`, "utf-8");
    } catch (err) {
      debugLogger.error(
        "Failed to write note file",
        { noteId: note.id, error: err.message },
        "note-files"
      );
    }
  }

  writeTranscript(note, folderName, speakerMappings) {
    if (!this._baseRealPath) return;
    try {
      const segments = JSON.parse(note.transcript || "[]");
      if (!segments.length) return;

      const dirPath = this._resolveFolderPath(folderName, { create: true });
      if (!dirPath) return;

      const slug = this._slugify(note.title);
      const newFileName = `${note.id}-${slug}-transcript.md`;
      const newFilePath = path.join(dirPath, newFileName);
      this._assertWritableFilePath(newFilePath);

      const stale = this._globTranscriptFiles(note.id);
      for (const existing of stale) {
        if (existing !== newFilePath) {
          try {
            fs.unlinkSync(existing);
          } catch {}
        }
      }

      const { formatMd } = require("./transcriptFormatter");
      fs.writeFileSync(newFilePath, formatMd(note, segments, speakerMappings || {}), "utf-8");
    } catch (err) {
      debugLogger.error(
        "Failed to write transcript file",
        { noteId: note.id, error: err.message },
        "note-files"
      );
    }
  }

  deleteNote(noteId) {
    if (!this._baseRealPath) return;
    try {
      const files = [...this._globNoteFiles(noteId), ...this._globTranscriptFiles(noteId)];
      for (const f of files) this._unlinkNoteFile(f);
    } catch (err) {
      debugLogger.error("Failed to delete note file", { noteId, error: err.message }, "note-files");
    }
  }

  // Isolate each unlink like writeNote/writeTranscript do: a single file we
  // can't remove (e.g. locked by an external editor) must not orphan the
  // note's other mirrored files.
  _unlinkNoteFile(filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      debugLogger.error(
        "Failed to delete note file",
        { file: filePath, error: err.message },
        "note-files"
      );
    }
  }

  ensureFolder(folderName) {
    if (!this._baseRealPath) return;
    try {
      this._resolveFolderPath(folderName, { create: true });
    } catch (err) {
      debugLogger.error(
        "Failed to ensure folder",
        { folderName, error: err.message },
        "note-files"
      );
    }
  }

  // Returns true once the whole directory has moved. False leaves whatever
  // couldn't move at the old path, and the caller rewrites the notes.
  renameFolder(oldName, newName) {
    if (!this._baseRealPath) return false;
    try {
      const oldPath = this._resolveFolderPath(oldName);
      if (!oldPath) return false;
      const newPath = this._folderCandidatePath(newName);
      if (!newPath || oldPath === newPath) return false;
      if (Array.isArray(newName)) this._resolveFolderPath(newName[0], { create: true });
      const existingPath = fs.existsSync(newPath) ? this._resolveExistingFolderPath(newPath) : null;
      // A same-named folder in another space shares the directory, so move in
      // beside it; a case-only rename finds the folder itself there.
      if (existingPath && this._directoryId(existingPath) !== this._directoryId(oldPath)) {
        return this._mergeDirectory(oldPath, existingPath);
      }
      fs.renameSync(oldPath, newPath);
      return true;
    } catch (err) {
      debugLogger.error(
        "Failed to rename folder",
        { oldName, newName, error: err.message },
        "note-files"
      );
      return false;
    }
  }

  // The folder may hold files that aren't the app's, so this only takes the
  // given notes' files and then whichever directories that left empty.
  deleteFolder(folderName, noteIds = []) {
    if (!this._baseRealPath) return;
    try {
      const dirPath = this._resolveFolderPath(folderName);
      if (!dirPath) return;
      this._deleteNoteFilesIn(dirPath, noteIds);
      this._removeEmptyDirectories(dirPath);
    } catch (err) {
      debugLogger.error(
        "Failed to delete folder",
        { folderName, error: err.message },
        "note-files"
      );
    }
  }

  _deleteNoteFilesIn(dirPath, noteIds) {
    const ids = new Set(noteIds.map(String));
    for (const file of fs.readdirSync(dirPath)) {
      const filePath = path.join(dirPath, file);
      if (
        ids.has(file.split("-", 1)[0]) &&
        (this._isNoteFile(file, filePath) || this._isTranscriptFile(file, filePath))
      ) {
        this._unlinkNoteFile(filePath);
      }
    }
  }

  _removeEmptyDirectories(dirPath) {
    try {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        // A symlink isn't a directory here: it counts as content and stays.
        if (entry.isDirectory()) this._removeEmptyDirectories(path.join(dirPath, entry.name));
      }
      fs.rmdirSync(dirPath);
    } catch {
      // Not empty or in use, which is normal: the directory stays.
    }
  }

  // Moves each entry that has nothing at its name in the target and leaves the
  // rest, so neither side's files are replaced. Returns whether the source is gone.
  _mergeDirectory(sourcePath, targetPath) {
    let moved = true;
    for (const name of fs.readdirSync(sourcePath)) {
      const sourceEntry = path.join(sourcePath, name);
      const targetEntry = path.join(targetPath, name);
      try {
        const targetStats = fs.lstatSync(targetEntry, { throwIfNoEntry: false });
        if (!targetStats) {
          fs.renameSync(sourceEntry, targetEntry);
        } else if (targetStats.isDirectory() && fs.lstatSync(sourceEntry).isDirectory()) {
          moved = this._mergeDirectory(sourceEntry, targetEntry) && moved;
        } else {
          moved = false;
        }
      } catch (err) {
        moved = false;
        debugLogger.debug(
          "Left a file behind in a folder merge",
          { file: sourceEntry, error: err.message },
          "note-files"
        );
      }
    }
    if (!moved) return false;
    fs.rmdirSync(sourcePath);
    return true;
  }

  rebuildAll(notes, folderMap, speakerMappingsMap) {
    if (!this._baseRealPath) return;
    try {
      for (const note of notes) {
        const folderName = folderMap[note.folder_id] || "Personal";
        this.writeNote(note, folderName);
        if (note.transcript) {
          this.writeTranscript(note, folderName, speakerMappingsMap?.[note.id] || {});
        }
      }
      debugLogger.info("Markdown mirror rebuild complete", { count: notes.length }, "note-files");
    } catch (err) {
      debugLogger.error("Failed to rebuild all note files", { error: err.message }, "note-files");
    }
  }

  getNotePath(noteId) {
    if (!this._baseRealPath) return null;
    const files = this._globNoteFiles(noteId);
    return files.length > 0 ? this._displayPath(files[0]) : null;
  }

  getFolderPath(folderName) {
    if (!this._baseRealPath) return null;
    try {
      const canonicalPath = this._resolveFolderPath(folderName);
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

  _isNoteFile(file, filePath) {
    return file.endsWith(".md") && this._isNoteMarkdownFile(filePath);
  }

  _isTranscriptFile(file, filePath) {
    if (!file.endsWith("-transcript.txt") && !file.endsWith("-transcript.md")) return false;
    try {
      if (!fs.lstatSync(filePath).isFile()) return false;
    } catch {
      return false;
    }
    return file.endsWith(".txt") || !this._isNoteMarkdownFile(filePath);
  }

  // Which directory a path is. Only the file system can say whether two names
  // are one directory (APFS folds Straße and STRASSE together); bigint because
  // a Windows file index doesn't fit a double.
  _directoryId(dirPath) {
    const { dev, ino } = fs.statSync(dirPath, { bigint: true });
    // Some network and FUSE file systems report no inode for every directory.
    return ino === 0n ? fs.realpathSync(dirPath) : `${dev}:${ino}`;
  }

  // Null while the folder has no directory.
  folderDirectoryId(folderName) {
    const candidatePath = this._folderCandidatePath(folderName);
    if (!candidatePath) return null;
    try {
      return this._directoryId(candidatePath);
    } catch {
      return null;
    }
  }

  _knownSubfolders() {
    try {
      return this._subfolderResolver?.() ?? [];
    } catch {
      return [];
    }
  }

  // Every top-level directory and every known subfolder's. Any other directory
  // at the second level is the user's, so copies of notes kept there aren't
  // mistaken for the notes' own files.
  _folderDirs() {
    const dirs = new Map();
    const add = (resolveDir) => {
      try {
        const dirPath = resolveDir();
        if (!dirPath) return;
        const directoryId = this._directoryId(dirPath);
        if (!dirs.has(directoryId)) dirs.set(directoryId, dirPath);
      } catch {}
    };
    for (const entry of fs.readdirSync(this._baseRealPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        add(() => this._resolveExistingFolderPath(path.join(this._baseRealPath, entry.name)));
      }
    }
    for (const subfolder of this._knownSubfolders()) {
      add(() => this._resolveFolderPath(subfolder));
    }
    return [...dirs.values()];
  }

  _globFiles(noteId, matches) {
    if (!this._baseRealPath) return [];
    const results = [];
    try {
      const prefix = `${noteId}-`;
      for (const dirPath of this._folderDirs()) {
        for (const file of fs.readdirSync(dirPath)) {
          if (file.startsWith(prefix) && matches(file, path.join(dirPath, file))) {
            results.push(path.join(dirPath, file));
          }
        }
      }
    } catch {}
    return results;
  }

  _globNoteFiles(noteId) {
    return this._globFiles(noteId, (file, filePath) => this._isNoteFile(file, filePath));
  }

  _globTranscriptFiles(noteId) {
    return this._globFiles(noteId, (file, filePath) => this._isTranscriptFile(file, filePath));
  }
}

module.exports = new MarkdownMirror();
