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

  _folderCandidatePath(folderName) {
    if (!this._baseRealPath) return null;
    return path.join(this._baseRealPath, this._safeFolderName(folderName));
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

      const frontmatter = this._buildFrontmatter(note, folderName || "Personal");
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
      for (const f of files) {
        // Isolate each unlink like writeNote/writeTranscript do: a single file we
        // can't remove (e.g. locked by an external editor) must not orphan the
        // note's other mirrored files.
        try {
          fs.unlinkSync(f);
        } catch (err) {
          debugLogger.error(
            "Failed to delete note file",
            { noteId, file: f, error: err.message },
            "note-files"
          );
        }
      }
    } catch (err) {
      debugLogger.error("Failed to delete note file", { noteId, error: err.message }, "note-files");
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

  renameFolder(oldName, newName) {
    if (!this._baseRealPath) return;
    try {
      const oldPath = this._resolveFolderPath(oldName);
      if (!oldPath) return;
      const newPath = this._folderCandidatePath(newName);
      if (!newPath || oldPath === newPath) return;
      if (fs.existsSync(newPath)) this._resolveExistingFolderPath(newPath);
      fs.renameSync(oldPath, newPath);
    } catch (err) {
      debugLogger.error(
        "Failed to rename folder",
        { oldName, newName, error: err.message },
        "note-files"
      );
    }
  }

  deleteFolder(folderName) {
    if (!this._baseRealPath) return;
    try {
      const dirPath = this._resolveFolderPath(folderName);
      if (dirPath) fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (err) {
      debugLogger.error(
        "Failed to delete folder",
        { folderName, error: err.message },
        "note-files"
      );
    }
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
    return /^\uFEFF?---\r?\n/.test(this._readFileHead(filePath, 8) ?? "");
  }

  // A regular file's first bytes, or null for anything else.
  _readFileHead(filePath, length) {
    let fd;
    try {
      const stats = fs.lstatSync(filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) return null;
      fd = fs.openSync(filePath, "r");
      const head = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, head, 0, length, 0);
      return head.toString("utf8", 0, bytesRead);
    } catch {
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // A note file this mirror wrote: "<id>-<slug>.md" opening with its "id: <id>".
  _mirroredNoteId(filePath) {
    const id = /^(\d+)-.*\.md$/.exec(path.basename(filePath))?.[1];
    if (!id) return null;
    const head = this._readFileHead(filePath, 64) ?? "";
    return new RegExp(`^\\uFEFF?---\\r?\\nid: ${id}\\r?\\n`).test(head) ? id : null;
  }

  // Erasing local data (#3030) in a folder the user chose removes only what
  // this mirror wrote there: its note files, their transcripts, and folders
  // that leaves empty. The chosen folder itself stays.
  removeMirroredFiles(basePath) {
    const files = fs
      .readdirSync(basePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const folder = path.join(basePath, entry.name);
        try {
          return fs.readdirSync(folder).map((name) => path.join(folder, name));
        } catch {
          return []; // An unreadable folder holds nothing this mirror could have written.
        }
      });
    const noteIds = new Set();
    const owned = files.filter((file) => {
      const id = this._mirroredNoteId(file);
      if (id) noteIds.add(id);
      return id !== null;
    });
    for (const file of files) {
      const id = /^(\d+)-.*-transcript\.(?:md|txt)$/.exec(path.basename(file))?.[1];
      if (id && noteIds.has(id) && fs.lstatSync(file).isFile()) owned.push(file);
    }
    for (const file of owned) fs.rmSync(file, { force: true });
    // Only a folder this emptied: one the user left empty stays.
    for (const folder of new Set(owned.map((file) => path.dirname(file)))) {
      try {
        fs.rmdirSync(folder);
      } catch {
        /* Not empty: it holds files the mirror didn't write. */
      }
    }
  }

  _globNoteFiles(noteId) {
    if (!this._baseRealPath) return [];
    const results = [];
    try {
      const prefix = `${noteId}-`;
      const dirs = fs.readdirSync(this._baseRealPath, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
        let dirPath;
        try {
          dirPath = this._resolveExistingFolderPath(path.join(this._baseRealPath, dir.name));
        } catch {
          continue;
        }
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          if (
            file.startsWith(prefix) &&
            file.endsWith(".md") &&
            this._isNoteMarkdownFile(filePath)
          ) {
            results.push(filePath);
          }
        }
      }
    } catch {}
    return results;
  }

  _globTranscriptFiles(noteId) {
    if (!this._baseRealPath) return [];
    const results = [];
    try {
      const prefix = `${noteId}-`;
      const dirs = fs.readdirSync(this._baseRealPath, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
        let dirPath;
        try {
          dirPath = this._resolveExistingFolderPath(path.join(this._baseRealPath, dir.name));
        } catch {
          continue;
        }
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          let isRegularFile = false;
          try {
            const stats = fs.lstatSync(filePath);
            isRegularFile = stats.isFile() && !stats.isSymbolicLink();
          } catch {}
          if (
            isRegularFile &&
            file.startsWith(prefix) &&
            (file.endsWith("-transcript.txt") ||
              (file.endsWith("-transcript.md") && !this._isNoteMarkdownFile(filePath)))
          ) {
            results.push(filePath);
          }
        }
      }
    } catch {}
    return results;
  }
}

module.exports = new MarkdownMirror();
