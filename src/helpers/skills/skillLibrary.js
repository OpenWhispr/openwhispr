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
  replaceFrontmatterValue,
  replaceSkillBody,
  isTextFile,
  isScriptPath,
  contentHash,
} = require("./skillFormat");
const { readSkillArchive, isSafeArchivePath, hasClashingPaths } = require("./skillArchive");

const ARCHIVE_EXTENSIONS = new Set([".zip", ".skill"]);
const FINDER_JUNK = ".DS_Store";
// Ships with the app, read-only, and never listed in the library.
const BUILTIN_DIR = path.join(__dirname, "builtin");
const SKILL_CREATOR = "skill-creator";
// File text a model read may carry, and what an assistant proposal may write.
const MODEL_FILES_MAX_BYTES = 200 * 1024;
const PROPOSAL_LIMITS = { maxFiles: 20, maxFileBytes: 200 * 1024, maxBytes: 1024 * 1024 };
// Copies kept per skill for Undo, newest first; older ones are deleted.
const VERSIONS_KEPT = 5;
// Where a replace puts the old copy while the new one is swapped in, named for its skill.
const MOVED_ASIDE = /^\.(?:replaced|replacing)-[0-9a-f-]{36}-(.+)$/;
const WRITE_JOURNAL = /^\.(writing|written)-([0-9a-f-]{36})-(.+)\.json$/;

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
  const metadata = [];
  const pending = [""];
  while (pending.length > 0) {
    const relDir = pending.pop();
    const dir = relDir ? path.join(root, ...relDir.split("/")) : root;
    const directoryStats = fs.lstatSync(dir);
    metadata.push([
      relDir,
      directoryStats.size,
      directoryStats.mtimeMs,
      directoryStats.ctimeMs,
      directoryStats.mode,
    ]);
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
      files.push({ path: relPath, fullPath, size: stats.size, mode: stats.mode & 0o777 });
      bytes += stats.size;
      metadata.push([relPath, stats.size, stats.mtimeMs, stats.ctimeMs, stats.mode]);
      if (files.length > SKILL_LIMITS.maxFiles) return { files, bytes, tooMany: true };
    }
  }
  // Every entry matters: one future-dated file must not hide another file's edit or chmod.
  metadata.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return { files, bytes, tooMany: false, fingerprint: JSON.stringify(metadata) };
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

function readBuiltin(name) {
  const markdown = fs.readFileSync(path.join(BUILTIN_DIR, name, "SKILL.md"), "utf8");
  const { data, body } = parseSkillMarkdown(markdown);
  return { name, displayName: displayNameFor(name, data?.metadata), body, files: [] };
}

// The files an assistant proposal adds, as written: SKILL.md comes from its instructions.
function proposalFiles(files) {
  if (files.length > PROPOSAL_LIMITS.maxFiles) return { problem: { code: "tooManyFiles" } };
  const entries = files.map((file) => ({
    path: file.path.replace(/^\.\//, ""),
    data: Buffer.from(file.content),
  }));
  const unsafe = entries.find((entry) => !isSafeArchivePath(entry.path));
  if (unsafe) return { problem: { code: "unsafePath", values: { path: unsafe.path } } };
  if (hasClashingPaths(["SKILL.md", ...entries.map((entry) => entry.path)])) {
    return { problem: { code: "unsafePath" } };
  }
  return { files: entries };
}

function proposalSizeProblem(files) {
  let bytes = 0;
  for (const file of files) {
    if (file.data.length > PROPOSAL_LIMITS.maxFileBytes) return { code: "tooLarge" };
    bytes += file.data.length;
  }
  return bytes > PROPOSAL_LIMITS.maxBytes ? { code: "tooLarge" } : null;
}

const foldPath = (relPath) => relPath.normalize("NFC").toLowerCase();

function versionIds(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * The user's skills: one folder each under userData/skills, which is the only copy of a
 * skill's content. The database keeps only each skill's on/off state.
 */
class SkillLibrary {
  constructor({ userDataDir, database, recommendedDir }) {
    this.skillsDir = path.join(userDataDir, "skills");
    this.versionsDir = path.join(userDataDir, "skill-versions");
    this.database = database;
    this.recommendedDir = recommendedDir;
    this.inspected = new Map();
    this.uploads = new Map();
    this._recoverInterruptedWrites();
  }

  // Pending .replacing copies roll back even when the new folder arrived. Committed
  // .replaced copies are discarded when the target exists; otherwise they restore it.
  // Unresolved names cannot be written again until their original copy can be recovered.
  _recoverInterruptedWrites() {
    const unresolved = new Set();
    let entries;
    try {
      entries = fs.readdirSync(this.skillsDir);
    } catch {
      return unresolved;
    }
    // A journal owns both disk and database rollback. Keep its backups out of the legacy
    // recovery below, especially when restoring the database or directory is still blocked.
    const journalBackups = new Set();
    for (const entry of entries) {
      const journal = WRITE_JOURNAL.exec(entry);
      if (!journal || !isSkillFolderName(journal[3])) continue;
      const [, phase, id, name] = journal;
      if (phase === "written") {
        this._removeQuietly(path.join(this.skillsDir, entry));
        continue;
      }
      journalBackups.add(`.replacing-${id}-${name}`);
      journalBackups.add(`.replaced-${id}-${name}`);
      try {
        this._rollbackWrite(path.join(this.skillsDir, entry));
      } catch (error) {
        unresolved.add(name);
        debugLogger.error(
          "Could not recover a skill write",
          { name, error: error.message },
          "skills"
        );
      }
    }
    for (const entry of entries) {
      if (journalBackups.has(entry)) continue;
      const leftover = path.join(this.skillsDir, entry);
      const movedAside = MOVED_ASIDE.exec(entry)?.[1];
      if (movedAside && isSkillFolderName(movedAside)) {
        if (this._exists(movedAside)) {
          if (!entry.startsWith(".replacing-")) {
            this._discard(leftover);
            continue;
          }
          // A pending replacement never committed, even if its new folder reached the target.
          this._discard(path.join(this.skillsDir, movedAside));
          if (this._exists(movedAside)) {
            unresolved.add(movedAside);
            continue;
          }
        }
        try {
          renameWithRetry(leftover, path.join(this.skillsDir, movedAside));
        } catch (error) {
          unresolved.add(movedAside);
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
    // Versions are full copies of a skill's files, so they go with it.
    let versioned = [];
    try {
      versioned = fs.readdirSync(this.versionsDir);
    } catch {
      return unresolved;
    }
    for (const name of versioned) {
      if (!isSkillFolderName(name)) continue;
      const folder = path.join(this.versionsDir, name);
      // A skill this start couldn't put back keeps them for the start that does.
      const waiting = entries.some((entry) => MOVED_ASIDE.exec(entry)?.[1] === name);
      if (!this._exists(name) && !waiting) {
        this._removeQuietly(folder);
        continue;
      }
      // A snapshot without its commit note must not block Undo of the last completed save.
      for (const versionId of versionIds(folder)) {
        if (!fs.existsSync(path.join(folder, `${versionId}.json`))) {
          this._removeQuietly(path.join(folder, String(versionId)));
        }
      }
    }
    return unresolved;
  }

  scan() {
    fs.mkdirSync(this.skillsDir, { recursive: true });
    const found = new Map();
    const awaitingRecovery = new Set();
    const uncommitted = new Set();
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      const journal = WRITE_JOURNAL.exec(entry.name);
      if (journal?.[1] === "writing" && isSkillFolderName(journal[3])) {
        awaitingRecovery.add(journal[3]);
        uncommitted.add(journal[3]);
      }
      const movedAside = MOVED_ASIDE.exec(entry.name)?.[1];
      if (!movedAside || !isSkillFolderName(movedAside)) continue;
      awaitingRecovery.add(movedAside);
      if (entry.name.startsWith(".replacing-")) uncommitted.add(movedAside);
    }
    for (const entry of entries) {
      // Hidden names include the staging and trash folders of a write in progress. A name the
      // app can't address, such as a Windows device name, is left alone too: it couldn't be
      // opened, switched or removed from here.
      if (!isSkillFolderName(entry.name) || uncommitted.has(entry.name)) continue;
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
      // A temporary lock can leave the only copy moved aside until the next start.
      if (!found.has(name) && !awaitingRecovery.has(name)) this.database.deleteSkillState(name);
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
    this._removeQuietly(path.join(this.versionsDir, name));
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
    this._recoverInterruptedWrites();
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
    this._recoverInterruptedWrites();
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
    const name = this._newSkillName(cleanTitle);
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
    if (this._recoverInterruptedWrites().has(id)) {
      throw writeError(
        Object.assign(new Error("The skill needs recovery before it can be added"), {
          code: "EBUSY",
        })
      );
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

  // What the assistant reads: the built-in creator, or a skill that is on and valid.
  readForModel({ name, builtin, file, withFiles }) {
    if (builtin) return name === SKILL_CREATOR ? readBuiltin(name) : null;
    const skill = this.get(name);
    if (!skill?.enabled || !skill.valid) return null;
    const files = skill.files.map((entry) => ({ ...entry }));
    if (file !== undefined) {
      const entry = files.find((candidate) => candidate.path === file && candidate.text);
      const content = entry ? this.readFile(name, file) : null;
      if (content === null) return null;
      entry.content = content;
    } else if (withFiles) {
      let room = MODEL_FILES_MAX_BYTES;
      for (const entry of files) {
        if (!entry.text) continue;
        if (entry.size > room) break;
        const content = this.readFile(name, entry.path);
        if (content === null) continue;
        entry.content = content;
        room -= entry.size;
      }
    }
    const { body } = parseSkillMarkdown(skill.markdown);
    return { name, displayName: skill.displayName, body, files };
  }

  // Checked before the user sees a card, so the assistant can fix what it proposed. An update
  // needs a skill that is on and valid; null means there's none to change. A card that changes
  // a skill carries its hash, so its save can tell whether the skill changed since.
  checkProposal(request) {
    if (request.kind === "update") {
      const { name } = request.update;
      const updated = this._updatedSkill(request.update);
      return updated && { name, existing: true, problems: updated.problems, ...this._hashOf(name) };
    }
    const { name, existing, problems } = this._proposedSkill(request.proposal);
    return { name, existing, problems, ...(existing ? this._hashOf(name) : {}) };
  }

  // An approved proposal. One named like a skill the user has updates it, keeping a version.
  saveProposal(proposal) {
    this._recoverInterruptedWrites();
    const { name, existing, problems, files } = this._proposedSkill(proposal);
    if (problems.length > 0) return { problems };
    // A card carries a hash only when it was made to update a skill. One whose skill is gone
    // since would quietly make a new skill, and one made as new would replace a skill that took
    // its title since, unseen: both are cards the skill changed under.
    if (existing !== (proposal.baseHash !== undefined)) return { changed: true };
    if (!existing) {
      this._install(name, files);
      return { name };
    }
    if (this._changedSince(name, proposal.baseHash)) return { changed: true };
    const versionId = this._withVersion(name, files, { enabledAfter: true });
    return { name, versionId };
  }

  // An approved change to a skill that is on and valid: the header keeps every other line,
  // and every file it doesn't change stays byte for byte.
  applyUpdate(update) {
    this._recoverInterruptedWrites();
    const updated = this._updatedSkill(update);
    if (!updated || updated.problems.length > 0) return updated && { problems: updated.problems };
    if (this._changedSince(update.name, update.baseHash)) return { changed: true };
    const versionId = this._withVersion(update.name, updated.files);
    return { name: update.name, versionId };
  }

  // Puts a kept copy back in one swap, then forgets it. False when there is no such copy, or
  // when the skill changed after the save that kept it (a later save, an upload, an edit by
  // hand, a delete): putting this one back would lose that change. A kept copy that can't be
  // read throws instead, since nothing changed the skill and the card offers Undo again.
  undo(name, versionId) {
    if (this._recoverInterruptedWrites().has(name)) {
      throw writeError(new Error("The skill still needs recovery before Undo"));
    }
    const versionDir = path.join(this.versionsDir, name, versionId);
    if (!fs.existsSync(versionDir)) return false;
    if (versionIds(path.join(this.versionsDir, name)).at(-1) !== Number(versionId)) return false;
    let written;
    try {
      written = JSON.parse(fs.readFileSync(`${versionDir}.json`, "utf8"));
    } catch (error) {
      throw writeError(error);
    }
    if (this._folderHash(name) !== written.hash) return false;
    const walked = walkSkillFolder(versionDir);
    if (walked.unreadable) throw writeError(new Error("The kept copy can't be read"));
    const files = walked.files.map((file) => ({
      path: file.path,
      data: fs.readFileSync(file.fullPath),
      mode: file.mode,
    }));
    // The switch goes back too, unless the user changed it after the save.
    const enabledNow = this.database.getSkillStates().find((s) => s.name === name)?.enabled;
    const putBack = enabledNow === written.enabledAfter ? { enabled: written.enabled } : {};
    this._writeSkillFolder(name, files, () => this._stamp(name, files, putBack));
    this._removeQuietly(versionDir);
    this._removeQuietly(`${versionDir}.json`);
    return true;
  }

  // A copy of the skill as it is now, for Undo to put back. Ids only grow, so the newest
  // copies are always the ones kept. A copy cut short is removed, so it never counts as one.
  saveVersion(name) {
    const folder = path.join(this.versionsDir, name);
    const versionId = String(Math.max(Date.now(), (versionIds(folder).at(-1) ?? 0) + 1));
    const versionDir = path.join(folder, versionId);
    try {
      fs.cpSync(path.join(this.skillsDir, name), versionDir, { recursive: true });
    } catch (error) {
      this._removeQuietly(versionDir);
      throw writeError(error);
    }
    return versionId;
  }

  // Only once a new version is complete do the oldest go, so a save that fails keeps them all.
  _pruneVersions(name) {
    const folder = path.join(this.versionsDir, name);
    const kept = versionIds(folder);
    for (const old of kept.slice(0, Math.max(0, kept.length - VERSIONS_KEPT))) {
      this._removeQuietly(path.join(folder, String(old)));
      this._removeQuietly(path.join(folder, `${old}.json`));
    }
  }

  markUsed(name) {
    this.database.markSkillUsed(name);
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

  _proposedSkill({ title, description, instructions, files }) {
    const cleanTitle = title.trim();
    // A title one of the user's skills shows updates that skill. Any other gets a folder of its
    // own, as Create does: titles with no Latin letters all slug to the same fallback name.
    const existingSkill = this._skillTitled(cleanTitle);
    const name = existingSkill?.name ?? this._newSkillName(cleanTitle);
    const existing = existingSkill !== undefined;
    const refuse = (problem) => ({ name, existing, problems: [problem], files: [] });
    if (!cleanTitle) return refuse({ code: "missingName" });
    const attachments = proposalFiles(files);
    if (attachments.problem) return refuse(attachments.problem);
    const skillFile = {
      path: "SKILL.md",
      data: Buffer.from(
        existing && existingSkill.valid
          ? this._editedMarkdown(name, { description, instructions })
          : buildSkillMarkdown({ name, title: cleanTitle, description, instructions })
      ),
    };
    const limit = proposalSizeProblem([skillFile, ...attachments.files]);
    if (limit) return refuse(limit);
    // Updating a skill keeps the files the proposal doesn't name, as update_skill does.
    const merged = existing
      ? this._withKeptFiles(name, skillFile, attachments.files)
      : { files: [skillFile, ...attachments.files] };
    if (merged.problem) return refuse(merged.problem);
    const { problems } = validateSkillFiles(merged.files, {
      ...(existing ? { folderName: name } : {}),
      source: "app",
    });
    return { name, existing, problems, files: merged.files };
  }

  _updatedSkill({ name, description, instructions, files }) {
    const skill = this.get(name);
    if (!skill?.enabled || !skill.valid) return null;
    const refuse = (problem) => ({ problems: [problem], files: [] });
    const changed = proposalFiles(files);
    if (changed.problem) return refuse(changed.problem);
    const skillFile = {
      path: "SKILL.md",
      data: Buffer.from(this._editedMarkdown(name, { description, instructions }, skill)),
    };
    // The skill's size was checked when it arrived; the change is held to proposal limits.
    const limit = proposalSizeProblem(
      instructions !== undefined ? [skillFile, ...changed.files] : changed.files
    );
    if (limit) return refuse(limit);
    const merged = this._withKeptFiles(name, skillFile, changed.files);
    if (merged.problem) return refuse(merged.problem);
    const { problems } = validateSkillFiles(merged.files, { folderName: name, source: "app" });
    return { problems, files: merged.files };
  }

  // The skill's SKILL.md with a new description and instructions; every other header line stays.
  _editedMarkdown(name, { description, instructions }, skill = this.get(name)) {
    let markdown = skill.markdown;
    if (description !== undefined) {
      markdown = replaceFrontmatterValue(markdown, "description", description.trim());
    }
    if (instructions !== undefined) markdown = replaceSkillBody(markdown, instructions);
    return markdown;
  }

  // The change's SKILL.md and files, plus every other file the skill has, byte for byte.
  _withKeptFiles(name, skillFile, changedFiles) {
    const folder = this.skillDir(name);
    const walked = folder ? walkSkillFolder(folder) : { unreadable: true };
    if (walked.unreadable) return { problem: { code: "unreadable" } };
    if (walked.tooMany) return { problem: { code: "tooManyFiles" } };
    const replaced = new Set(changedFiles.map((file) => foldPath(file.path)));
    const kept = walked.files
      .filter((file) => file.path !== "SKILL.md" && !replaced.has(foldPath(file.path)))
      .map((file) => ({ path: file.path, data: fs.readFileSync(file.fullPath) }));
    const modes = new Map(walked.files.map((file) => [foldPath(file.path), file.mode]));
    const files = [skillFile, ...kept, ...changedFiles].map((file) => ({
      ...file,
      mode: modes.get(foldPath(file.path)),
    }));
    if (hasClashingPaths(files.map((file) => file.path))) {
      return { problem: { code: "unsafePath" } };
    }
    const size = sizeProblem(files);
    return size ? { problem: size } : { files };
  }

  // A skill that can't be read has no hash, and a card without one can't save over it.
  _hashOf(name) {
    const hash = this._folderHash(name);
    return hash ? { hash } : {};
  }

  // A card is built against the skill as it was then; a save after the skill changed (another
  // card, an edit by hand, an upload) would throw that change away unseen.
  _changedSince(name, baseHash) {
    return baseHash !== undefined && baseHash !== this._folderHash(name);
  }

  // Keeps a version, then writes; a failed write leaves the skill and its versions as they were.
  // Beside the version goes what the write left and whether the skill was on, so Undo can tell
  // whether the skill changed since and put its switch back too. Once the new copy is in, the
  // save has happened: a note that can't be written only costs this save its Undo.
  _withVersion(name, files, { enabledAfter } = {}) {
    const enabled = this.database.getSkillStates().find((state) => state.name === name)?.enabled;
    const versionId = this.saveVersion(name);
    const versionDir = path.join(this.versionsDir, name, versionId);
    try {
      this._writeSkillFolder(name, files, () =>
        this._stamp(name, files, enabledAfter === undefined ? {} : { enabled: enabledAfter })
      );
    } catch (error) {
      this._removeQuietly(versionDir);
      throw error;
    }
    try {
      const written = {
        hash: this._folderHash(name),
        enabled: enabled === true,
        enabledAfter: enabledAfter ?? enabled === true,
      };
      fs.writeFileSync(`${versionDir}.json`, JSON.stringify(written));
      this._pruneVersions(name);
      return versionId;
    } catch (error) {
      debugLogger.warn(
        "Saved a skill without the note its Undo needs",
        { name, error: error.message },
        "skills"
      );
      this._removeQuietly(versionDir);
      this._removeQuietly(`${versionDir}.json`);
      return undefined;
    }
  }

  // Null for a skill that is gone or can't be read, which matches no card's hash.
  _folderHash(name) {
    const folder = this.skillDir(name);
    if (!folder) return null;
    const walked = walkSkillFolder(folder);
    if (walked.unreadable) return null;
    return contentHash(
      walked.files.map((file) => ({ path: file.path, data: fs.readFileSync(file.fullPath) }))
    );
  }

  // A new skill starts on; one that replaces a skill keeps that skill's switch.
  _install(name, files) {
    const replacing = this._exists(name);
    const unresolved = this._recoverInterruptedWrites();
    // A newly restored target was absent at the caller's duplicate check and needs approval.
    if (unresolved.has(name) || (!replacing && this._exists(name))) {
      throw writeError(
        Object.assign(new Error("The skill needs recovery or a new replace decision"), {
          code: "EBUSY",
        })
      );
    }
    this._writeSkillFolder(name, files, () => {
      this._stamp(name, files, replacing ? {} : { enabled: true });
    });
  }

  _stamp(name, files, state) {
    this.inspected.delete(name);
    this.database.upsertSkillState(name, { ...state, contentHash: contentHash(files) });
  }

  // A pending journal keeps the complete old row, including its switch and timestamps.
  // Recovery can retry either half without publishing a failed installation as a new skill.
  _rollbackWrite(journalPath, staging) {
    const [, , id, name] = WRITE_JOURNAL.exec(path.basename(journalPath));
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    if (
      typeof journal.replacing !== "boolean" ||
      !(journal.state === null || journal.state?.name === name)
    ) {
      throw new Error("Invalid skill write journal");
    }
    const currentState =
      this.database.getSkillStates().find((entry) => entry.name === name) ?? null;
    // A failed initial database write needs no compensating write, even on a read-only disk.
    if (JSON.stringify(currentState) !== JSON.stringify(journal.state)) {
      this.database.restoreSkillState(name, journal.state);
    }
    const target = path.join(this.skillsDir, name);
    const backup = ["replacing", "replaced"]
      .map((phase) => path.join(this.skillsDir, `.${phase}-${id}-${name}`))
      .find((folder) => fs.existsSync(folder));
    if (backup || !journal.replacing) {
      if (this._exists(name)) {
        if (staging) renameWithRetry(target, staging);
        else {
          this._discard(target);
          if (this._exists(name)) throw new Error("The failed skill write is still locked");
        }
      }
      if (backup) renameWithRetry(backup, target);
    }
    fs.unlinkSync(journalPath);
    this.inspected.delete(name);
  }

  // Writes into a staging folder, then swaps it in. The journal commits only after both
  // the directory and database have succeeded; cleanup after that cannot roll the save back.
  _writeSkillFolder(name, files, saveState) {
    const id = crypto.randomUUID();
    const staging = path.join(this.skillsDir, `.staging-${id}`);
    const journalStaging = `${staging}.json`;
    const journalPath = path.join(this.skillsDir, `.writing-${id}-${name}.json`);
    const committedJournal = path.join(this.skillsDir, `.written-${id}-${name}.json`);
    const target = path.join(this.skillsDir, name);
    let movedAside = null;
    try {
      for (const file of files) {
        const destination = path.join(staging, ...file.path.split("/"));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        // The filesystem is the final authority on aliases that preflight may not know.
        fs.writeFileSync(destination, file.data, { flag: "wx" });
        // chmod after creation preserves existing permissions even under a stricter umask.
        if (process.platform !== "win32" && file.mode !== undefined) {
          fs.chmodSync(destination, file.mode);
        }
      }
      const replacing = this._exists(name);
      const state = this.database.getSkillStates().find((entry) => entry.name === name) ?? null;
      // Publish the journal atomically so a partial write cannot strand an untouched skill.
      fs.writeFileSync(journalStaging, JSON.stringify({ replacing, state }), { flag: "wx" });
      renameWithRetry(journalStaging, journalPath);
      if (replacing) {
        movedAside = path.join(this.skillsDir, `.replacing-${id}-${name}`);
        renameWithRetry(target, movedAside);
      }
      renameWithRetry(staging, target);
      saveState();
      if (movedAside) {
        const committed = path.join(this.skillsDir, `.replaced-${id}-${name}`);
        renameWithRetry(movedAside, committed);
        movedAside = committed;
      }
      renameWithRetry(journalPath, committedJournal);
    } catch (error) {
      if (fs.existsSync(journalPath)) {
        try {
          this._rollbackWrite(journalPath, staging);
        } catch (restoreError) {
          debugLogger.error(
            "Could not roll back a skill write; its journal will retry on restart",
            { name, error: restoreError.message },
            "skills"
          );
        }
      }
      this._removeQuietly(staging);
      this._removeQuietly(journalStaging);
      debugLogger.error("Failed to write a skill", { name, error: error.message }, "skills");
      throw writeError(error);
    }
    this._removeQuietly(committedJournal);
    if (movedAside) this._discard(movedAside);
  }

  // The skill already showing this title, ignoring case, spacing and how accents are encoded.
  _skillTitled(title) {
    const key = (text) => text.trim().replace(/\s+/g, " ").normalize("NFC").toLowerCase();
    return this.scan().find((skill) => key(skill.displayName) === key(title));
  }

  // A starter skill's name stays free, so that starter can still be added.
  _newSkillName(title) {
    return slugifySkillName(title, new Set([...this._takenNames(), ...this._recommendedIds()]));
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
