const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

class MarkdownMirror {
  constructor() {
    this._basePath = null;
  }

  init(basePath) {
    this._basePath = basePath;
    try {
      fs.mkdirSync(basePath, { recursive: true });
      debugLogger.debug("Markdown mirror initialized", { basePath }, "note-files");
    } catch (err) {
      debugLogger.error("Failed to init markdown mirror", { error: err.message }, "note-files");
    }
  }

  getBasePath() {
    return this._basePath;
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
      if (/[:#{}[\],&*?|>!%@`]/.test(str) || str.includes('"') || str.includes("'")) {
        return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
    if (!this._basePath) return;
    try {
      const dirName = folderName || "Personal";
      const dirPath = path.join(this._basePath, dirName);
      fs.mkdirSync(dirPath, { recursive: true });

      // Remove stale files (title changed or note moved to different folder)
      const glob = this._globNoteFiles(note.id);
      const slug = this._slugify(note.title);
      const newFileName = `${note.id}-${slug}.md`;
      const newFilePath = path.join(dirPath, newFileName);
      for (const existing of glob) {
        if (existing !== newFilePath) {
          try {
            fs.unlinkSync(existing);
          } catch {}
        }
      }

      const frontmatter = this._buildFrontmatter(note, dirName);
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
    if (!this._basePath) return;
    try {
      const segments = JSON.parse(note.transcript || "[]");
      if (!segments.length) return;

      const dirName = folderName || "Personal";
      const dirPath = path.join(this._basePath, dirName);
      fs.mkdirSync(dirPath, { recursive: true });

      const slug = this._slugify(note.title);
      const newFileName = `${note.id}-${slug}-transcript.md`;
      const newFilePath = path.join(dirPath, newFileName);

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
    if (!this._basePath) return;
    try {
      const files = [...this._globNoteFiles(noteId), ...this._globTranscriptFiles(noteId)];
      for (const f of files) {
        fs.unlinkSync(f);
      }
    } catch (err) {
      debugLogger.error("Failed to delete note file", { noteId, error: err.message }, "note-files");
    }
  }

  ensureFolder(folderName) {
    if (!this._basePath) return;
    try {
      fs.mkdirSync(path.join(this._basePath, folderName), { recursive: true });
    } catch (err) {
      debugLogger.error(
        "Failed to ensure folder",
        { folderName, error: err.message },
        "note-files"
      );
    }
  }

  renameFolder(oldName, newName) {
    if (!this._basePath) return;
    try {
      const oldPath = path.join(this._basePath, oldName);
      const newPath = path.join(this._basePath, newName);
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath);
      }
    } catch (err) {
      debugLogger.error(
        "Failed to rename folder",
        { oldName, newName, error: err.message },
        "note-files"
      );
    }
  }

  deleteFolder(folderName) {
    if (!this._basePath) return;
    try {
      const dir = path.join(this._basePath, folderName);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      debugLogger.error(
        "Failed to delete folder",
        { folderName, error: err.message },
        "note-files"
      );
    }
  }

  rebuildAll(notes, folderMap, speakerMappingsMap) {
    if (!this._basePath) return;
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
    if (!this._basePath) return null;
    const files = this._globNoteFiles(noteId);
    return files.length > 0 ? files[0] : null;
  }

  getFolderPath(folderName) {
    if (!this._basePath) return null;
    const dirPath = path.join(this._basePath, folderName);
    return fs.existsSync(dirPath) ? dirPath : null;
  }

  _globNoteFiles(noteId) {
    if (!this._basePath) return [];
    const results = [];
    try {
      const prefix = `${noteId}-`;
      const dirs = fs.readdirSync(this._basePath, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const dirPath = path.join(this._basePath, dir.name);
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          if (file.startsWith(prefix) && file.endsWith(".md")) {
            results.push(path.join(dirPath, file));
          }
        }
      }
    } catch {}
    return results;
  }

  _globTranscriptFiles(noteId) {
    if (!this._basePath) return [];
    const results = [];
    try {
      const prefix = `${noteId}-`;
      const dirs = fs.readdirSync(this._basePath, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const dirPath = path.join(this._basePath, dir.name);
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          if (
            file.startsWith(prefix) &&
            (file.endsWith("-transcript.md") || file.endsWith("-transcript.txt"))
          ) {
            results.push(path.join(dirPath, file));
          }
        }
      }
    } catch {}
    return results;
  }
}

module.exports = new MarkdownMirror();
