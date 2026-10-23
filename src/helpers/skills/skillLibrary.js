const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const debugLogger = require("../debugLogger");
const {
  SKILL_LIMITS,
  parseSkillMarkdown,
  validateSkillFiles,
  displayNameFor,
  slugifySkillName,
  buildSkillMarkdown,
  isTextFile,
  isScriptPath,
  contentHash,
} = require("./skillFormat");
const { readSkillArchive, isSafeArchivePath, hasClashingPaths } = require("./skillArchive");

const ARCHIVE_EXTENSIONS = new Set([".zip", ".skill"]);
const FINDER_JUNK = ".DS_Store";
// Where a replace puts the old copy while the new one is swapped in, named for its skill.
const MOVED_ASIDE = /^\.replaced-[0-9a-f-]{36}-(.+)$/;

// A name the library can address on disk: one path segment that isn't hidden. Wider than
// SKILL_NAME_PATTERN, so a folder dropped in under any name can still be shown and removed.
function isSkillFolderName(name) {
  return (
    typeof name === "string" &&
    !name.startsWith(".") &&
    !name.includes("/") &&
    isSafeArchivePath(name)
  );
}

// Windows refuses a rename for a moment while antivirus or the search indexer holds a file it
// just saw written, so a rename there is tried again for about half a second in all.
const RENAME_RETRY_DELAYS_MS = [50, 100, 150, 200];
const BUSY_CODES = ["EPERM", "EACCES", "EBUSY"];

function renameWithRetry(from, to) {
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      if (process.platform !== "win32" || !BUSY_CODES.includes(error.code)) throw error;
      if (fs.existsSync(to)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
  return fs.renameSync(from, to);
}

function isInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

// The reason a write failed, as the screens name it.
function writeErrorCode(error) {
  return ["noSpace", "permission"].includes(error?.code) ? error.code : "unknown";
}

function writeError(error) {
  const code =
    error?.code === "ENOSPC"
      ? "noSpace"
      : ["EACCES", "EPERM", "EROFS"].includes(error?.code)
        ? "permission"
        : "unknown";
  return Object.assign(new Error(`Couldn't write the skill: ${error?.message}`), { code });
}

function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// Lists a skill folder without following links; any link makes the skill unreadable.
function walkSkillFolder(root) {
  const files = [];
  let bytes = 0;
  let newest = 0;
  const pending = [""];
  while (pending.length > 0) {
    const relDir = pending.pop();
    const dir = relDir ? path.join(root, ...relDir.split("/")) : root;
    newest = Math.max(newest, fs.lstatSync(dir).mtimeMs);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === FINDER_JUNK) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) return { unreadable: true };
      if (entry.isDirectory()) {
        pending.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const fullPath = path.join(dir, entry.name);
      const stats = fs.lstatSync(fullPath);
      files.push({ path: relPath, fullPath, size: stats.size });
      bytes += stats.size;
      newest = Math.max(newest, stats.mtimeMs);
      if (files.length > SKILL_LIMITS.maxFiles) return { files, bytes, tooMany: true };
    }
  }
  return { files, bytes, tooMany: false, fingerprint: `${files.length}:${bytes}:${newest}` };
}

function folderProblem(name, code) {
  return {
    name,
    displayName: displayNameFor(name, null),
    description: "",
    problems: [{ code }],
    warnings: [],
    hash: null,
  };
}

function toSummary(inspected, state) {
  const [problem] = inspected.problems;
  return {
    name: state.name,
    displayName: inspected.displayName,
    description: inspected.description,
    enabled: state.enabled,
    valid: !problem,
    ...(problem ? { problem } : {}),
    addedAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastUsedAt: state.lastUsedAt,
  };
}

function refusedUpload(fileName, problems) {
  return { fileName, status: "invalid", problems, warnings: [] };
}

// Create and Add refuse a title another skill already shows, so their cards can be told
// apart. The message names that skill as its card shows it.
function titleTaken(skill) {
  return { code: "nameTaken", values: { name: skill.displayName } };
}

function sizeProblem(files) {
  if (files.length > SKILL_LIMITS.maxFiles) return { code: "tooManyFiles" };
  const bytes = files.reduce((total, file) => total + file.data.length, 0);
  return bytes > SKILL_LIMITS.maxBytes ? { code: "tooLarge" } : null;
}

/**
 * The user's skills: one folder each under userData/skills, which is the only copy of a
 * skill's content. The database keeps only each skill's on/off state.
 */
class SkillLibrary {
  constructor({ userDataDir, database, recommendedDir }) {
    this.skillsDir = path.join(userDataDir, "skills");
    this.database = database;
    this.recommendedDir = recommendedDir;
    this.inspected = new Map();
    this.uploads = new Map();
    this._recoverInterruptedWrites();
  }

  // A write the app quit or crashed in the middle of leaves hidden folders. A skill moved aside
  // for a replace whose new copy never arrived goes back; the rest is deleted. This runs before
  // the first scan, which would otherwise drop the moved skill's record.
  _recoverInterruptedWrites() {
    let entries;
    try {
      entries = fs.readdirSync(this.skillsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const leftover = path.join(this.skillsDir, entry);
      const movedAside = MOVED_ASIDE.exec(entry)?.[1];
      if (movedAside && isSkillFolderName(movedAside)) {
        if (this._exists(movedAside)) {
          this._discard(leftover);
          continue;
        }
        try {
          renameWithRetry(leftover, path.join(this.skillsDir, movedAside));
        } catch (error) {
          debugLogger.error(
            "Could not put back a skill an interrupted write moved aside",
            { entry, error: error.message },
            "skills"
          );
        }
      } else if (entry.startsWith(".staging-") || entry.startsWith(".trash-")) {
        this._removeQuietly(leftover);
      }
    }
  }

  scan() {
    fs.mkdirSync(this.skillsDir, { recursive: true });
    const found = new Map();
    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      // Hidden names include the staging and trash folders of a write in progress. A name the
      // app can't address, such as a Windows device name, is left alone too: it couldn't be
      // opened, switched or removed from here.
      if (!isSkillFolderName(entry.name)) continue;
      if (entry.isSymbolicLink()) found.set(entry.name, folderProblem(entry.name, "unreadable"));
      else if (entry.isDirectory()) found.set(entry.name, this._inspect(entry.name));
    }
    for (const name of this.inspected.keys()) {
      if (!found.has(name)) this.inspected.delete(name);
    }

    const states = new Map(this.database.getSkillStates().map((state) => [state.name, state]));
    for (const [name, inspected] of found) {
      const state = states.get(name);
      // A folder that appeared outside the app stays off until the user switches it on.
      if (!state)
        this.database.upsertSkillState(name, { enabled: false, contentHash: inspected.hash });
      else if (inspected.hash && inspected.hash !== state.contentHash) {
        this.database.upsertSkillState(name, { contentHash: inspected.hash });
      }
    }
    for (const name of states.keys()) {
      if (!found.has(name)) this.database.deleteSkillState(name);
    }

    return this.database
      .getSkillStates()
      .filter((state) => found.has(state.name))
      .map((state) => toSummary(found.get(state.name), state));
  }

  get(name) {
    const summary = this.scan().find((skill) => skill.name === name);
    if (!summary) return null;
    // Marked as needing a fix, so nothing takes a skill whose files can't be read for one with
    // no instructions; the pop-up shows why.
    const unreadable = {
      ...summary,
      valid: false,
      problem: { code: "unreadable" },
      markdown: "",
      files: [],
    };
    const folder = this.skillDir(name);
    if (!folder) return unreadable;
    try {
      const walked = walkSkillFolder(folder);
      if (walked.unreadable) return unreadable;

      const readAll = !walked.tooMany && walked.bytes <= SKILL_LIMITS.maxBytes;
      let markdown = "";
      const files = [];
      for (const file of walked.files) {
        if (file.path === "SKILL.md") {
          if (file.size <= SKILL_LIMITS.maxBytes) {
            markdown = fs.readFileSync(file.fullPath).toString("utf8");
          }
          continue;
        }
        const data = readAll ? fs.readFileSync(file.fullPath) : null;
        files.push({
          path: file.path,
          size: file.size,
          text: data ? isTextFile(data) : false,
          script: isScriptPath(file.path),
        });
      }
      return { ...summary, markdown, files: files.sort(byPath) };
    } catch (error) {
      debugLogger.warn("Could not read a skill", { name, error: error.message }, "skills");
      return unreadable;
    }
  }

  readFile(name, relPath) {
    if (typeof relPath !== "string" || !isSafeArchivePath(relPath)) return null;
    const folder = this.skillDir(name);
    if (!folder) return null;
    const filePath = path.join(folder, ...relPath.replace(/^\.\//, "").split("/"));
    try {
      const stats = fs.lstatSync(filePath);
      if (!stats.isFile() || stats.size > SKILL_LIMITS.maxBytes) return null;
      // A folder on the way could still be a link, so the real path must stay in the skill.
      if (!isInside(folder, fs.realpathSync(filePath))) return null;
      const data = fs.readFileSync(filePath);
      return isTextFile(data) ? data.toString("utf8") : null;
    } catch {
      return null;
    }
  }

  setEnabled(name, enabled) {
    const skill = this.scan().find((entry) => entry.name === name);
    if (!skill || (enabled && !skill.valid)) return false;
    return this.database.setSkillEnabled(name, enabled);
  }

  uninstall(name) {
    if (!isSkillFolderName(name)) return;
    const trash = path.join(this.skillsDir, `.trash-${crypto.randomUUID()}`);
    try {
      renameWithRetry(path.join(this.skillsDir, name), trash);
    } catch (error) {
      if (error.code !== "ENOENT") throw writeError(error);
    }
    this._removeQuietly(trash);
    // Every copy goes: an old one a finished replace couldn't remove would otherwise come back
    // as this skill when the library next opens.
    for (const entry of fs.readdirSync(this.skillsDir)) {
      if (MOVED_ASIDE.exec(entry)?.[1] === name) this._discard(path.join(this.skillsDir, entry));
    }
    this.inspected.delete(name);
    this.database.deleteSkillState(name);
  }

  skillDir(name) {
    if (!isSkillFolderName(name)) return null;
    const folder = path.join(this.skillsDir, name);
    try {
      if (!fs.lstatSync(folder).isDirectory()) return null;
      const realFolder = fs.realpathSync(folder);
      return isInside(fs.realpathSync(this.skillsDir), realFolder) ? realFolder : null;
    } catch {
      return null;
    }
  }

  // `owner` is the window previewing them, so they can be let go when it goes away.
  async previewUploads(items, owner) {
    const batchNames = new Set();
    const previews = [];
    for (const item of items) {
      try {
        previews.push(await this._previewUpload(item, batchNames, owner));
      } catch (error) {
        // Refused alone, so one file the reader can't handle doesn't hide the rest of the drop.
        debugLogger.warn(
          "Could not preview an upload",
          { fileName: item.fileName, error: error.message },
          "skills"
        );
        previews.push(refusedUpload(item.fileName, [{ code: "unreadableArchive" }]));
      }
    }
    return previews;
  }

  commitUploads({ tokens, replace }) {
    const installed = [];
    const failed = [];
    for (const token of tokens) {
      const upload = this.uploads.get(token);
      if (!upload) {
        failed.push({ fileName: "", error: "unknown" });
        continue;
      }
      if (this._exists(upload.name) && !replace.includes(upload.name)) {
        // A skill by that name is there, as when one arrived since the preview: it isn't
        // replaced unasked, and the upload stays so it can be sent again to replace it.
        failed.push({ fileName: upload.fileName, error: "exists" });
        continue;
      }
      try {
        this._install(upload.name, upload.files);
      } catch (error) {
        // The token stays, so the same upload can be tried again.
        failed.push({ fileName: upload.fileName, error: writeErrorCode(error) });
        continue;
      }
      this.uploads.delete(token);
      // Listed once, even when a later upload in the same go replaced it.
      if (!installed.includes(upload.name)) installed.push(upload.name);
    }
    return { installed, failed };
  }

  // A previewed upload is held until it installs, or the screen or window that previewed it
  // lets go.
  discardUploads(tokens) {
    for (const token of tokens) this.uploads.delete(token);
  }

  discardUploadsFrom(owner) {
    for (const [token, upload] of this.uploads) {
      if (upload.owner === owner) this.uploads.delete(token);
    }
  }

  create({ title, description, instructions, files }) {
    const cleanTitle = title.trim();
    if (!cleanTitle) return { problems: [{ code: "missingName" }] };
    const twin = this._skillTitled(cleanTitle);
    if (twin) return { problems: [titleTaken(twin)] };
    const unsafe = files.find(
      (file) => file.fileName.includes("/") || !isSafeArchivePath(file.fileName)
    );
    if (unsafe) return { problems: [{ code: "unsafePath", values: { path: unsafe.fileName } }] };
    const attachments = files.map((file) => ({
      path: `${isScriptPath(file.fileName) ? "scripts" : "references"}/${file.fileName}`,
      data: Buffer.from(file.data),
    }));
    // Two files on one path would leave only the last one written.
    if (hasClashingPaths(attachments.map((file) => file.path))) {
      return { problems: [{ code: "unsafePath" }] };
    }
    // A starter skill's name stays free, so that starter can still be added.
    const taken = new Set([...this._takenNames(), ...this._recommendedIds()]);
    const name = slugifySkillName(cleanTitle, taken);
    const skillFiles = [
      {
        path: "SKILL.md",
        data: Buffer.from(
          buildSkillMarkdown({ name, title: cleanTitle, description, instructions })
        ),
      },
      ...attachments,
    ];
    const limit = sizeProblem(skillFiles);
    if (limit) return { problems: [limit] };
    const { problems } = validateSkillFiles(skillFiles, { source: "app" });
    if (problems.length > 0) return { problems };
    this._install(name, skillFiles);
    return { name };
  }

  // A shipped starter skill, with its title and description in the user's language.
  addRecommended(id, { title, description }) {
    if (!isSkillFolderName(id)) return null;
    let shipped;
    try {
      shipped = fs.readFileSync(path.join(this.recommendedDir, id, "SKILL.md"), "utf8");
    } catch {
      return null;
    }
    if (this._exists(id)) return { name: id };
    const twin = this._skillTitled(title);
    if (twin) return { problems: [titleTaken(twin)] };
    const markdown = buildSkillMarkdown({
      name: id,
      title,
      description,
      instructions: parseSkillMarkdown(shipped).body,
    });
    const files = [{ path: "SKILL.md", data: Buffer.from(markdown) }];
    const { problems } = validateSkillFiles(files, { source: "app" });
    if (problems.length > 0) return { problems };
    this._install(id, files);
    return { name: id };
  }

  _inspect(name) {
    let walked;
    try {
      walked = walkSkillFolder(path.join(this.skillsDir, name));
    } catch (error) {
      debugLogger.warn("Could not read a skill folder", { name, error: error.message }, "skills");
      return folderProblem(name, "unreadable");
    }
    if (walked.unreadable) return folderProblem(name, "unreadable");
    if (walked.tooMany) return folderProblem(name, "tooManyFiles");
    if (walked.bytes > SKILL_LIMITS.maxBytes) return folderProblem(name, "tooLarge");

    const cached = this.inspected.get(name);
    if (cached?.fingerprint === walked.fingerprint) return cached;
    let files;
    try {
      files = walked.files.map((file) => ({
        path: file.path,
        data: fs.readFileSync(file.fullPath),
      }));
    } catch (error) {
      debugLogger.warn("Could not read a skill's files", { name, error: error.message }, "skills");
      return folderProblem(name, "unreadable");
    }
    const inspected = {
      ...validateSkillFiles(files, { folderName: name, source: "disk" }),
      hash: contentHash(files),
      fingerprint: walked.fingerprint,
    };
    this.inspected.set(name, inspected);
    return inspected;
  }

  async _previewUpload({ fileName, data }, batchNames, owner) {
    const refuse = (problems) => refusedUpload(fileName, problems);
    if (data.length > SKILL_LIMITS.maxBytes) return refuse([{ code: "tooLarge" }]);
    const extension = path.extname(fileName).toLowerCase();
    let files;
    let rootFolder = null;
    if (extension === ".md") {
      files = [{ path: "SKILL.md", data: Buffer.from(data) }];
    } else if (ARCHIVE_EXTENSIONS.has(extension)) {
      const archive = await readSkillArchive(Buffer.from(data));
      if (archive.problems.length > 0) return refuse(archive.problems);
      ({ files, rootFolder } = archive);
    } else {
      return refuse([{ code: "unsupportedFile" }]);
    }

    const result = validateSkillFiles(files, {
      folderName: rootFolder ?? undefined,
      source: "upload",
    });
    if (result.problems.length > 0) return refuse(result.problems);
    const duplicate = batchNames.has(result.name) || this._exists(result.name);
    batchNames.add(result.name);
    const token = crypto.randomUUID();
    this.uploads.set(token, { fileName, name: result.name, files, owner });
    return {
      fileName,
      status: duplicate ? "duplicate" : "ready",
      token,
      name: result.name,
      displayName: result.displayName,
      problems: [],
      warnings: result.warnings,
    };
  }

  // A new skill starts on; one that replaces a skill keeps that skill's switch.
  _install(name, files) {
    const replacing = this._exists(name);
    this._writeSkillFolder(name, files);
    this.inspected.delete(name);
    this.database.upsertSkillState(name, {
      ...(replacing ? {} : { enabled: true }),
      contentHash: contentHash(files),
    });
  }

  // Writes into a staging folder, then swaps it in, so a failure never leaves half a skill.
  _writeSkillFolder(name, files) {
    const staging = path.join(this.skillsDir, `.staging-${crypto.randomUUID()}`);
    const target = path.join(this.skillsDir, name);
    let movedAside = null;
    try {
      for (const file of files) {
        const destination = path.join(staging, ...file.path.split("/"));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, file.data);
      }
      if (this._exists(name)) {
        movedAside = path.join(this.skillsDir, `.replaced-${crypto.randomUUID()}-${name}`);
        renameWithRetry(target, movedAside);
      }
      renameWithRetry(staging, target);
    } catch (error) {
      this._removeQuietly(staging);
      if (movedAside && fs.existsSync(movedAside) && !this._exists(name)) {
        try {
          renameWithRetry(movedAside, target);
        } catch (restoreError) {
          debugLogger.error(
            "Could not put a skill back after a failed write",
            { name, movedAside, error: restoreError.message },
            "skills"
          );
        }
      }
      debugLogger.error("Failed to write a skill", { name, error: error.message }, "skills");
      throw writeError(error);
    }
    if (movedAside) this._discard(movedAside);
  }

  // The skill already showing this title, ignoring case, spacing and how accents are encoded.
  _skillTitled(title) {
    const key = (text) => text.trim().replace(/\s+/g, " ").normalize("NFC").toLowerCase();
    return this.scan().find((skill) => key(skill.displayName) === key(title));
  }

  _recommendedIds() {
    try {
      return fs.readdirSync(this.recommendedDir);
    } catch {
      return [];
    }
  }

  _exists(name) {
    try {
      fs.lstatSync(path.join(this.skillsDir, name));
      return true;
    } catch {
      return false;
    }
  }

  _takenNames() {
    fs.mkdirSync(this.skillsDir, { recursive: true });
    return new Set(fs.readdirSync(this.skillsDir).map((name) => name.toLowerCase()));
  }

  // Renamed to trash first, so a folder that can't be removed now is cleared when the library
  // next opens, and never taken for a replace cut short; one that can't be renamed is removed
  // where it is.
  _discard(folder) {
    const trash = path.join(this.skillsDir, `.trash-${crypto.randomUUID()}`);
    try {
      renameWithRetry(folder, trash);
    } catch {
      this._removeQuietly(folder);
      return;
    }
    this._removeQuietly(trash);
  }

  _removeQuietly(target) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      debugLogger.warn(
        "Could not remove a skill folder",
        { target, error: error.message },
        "skills"
      );
    }
  }
}

module.exports = { SkillLibrary, isSkillFolderName, writeErrorCode };
