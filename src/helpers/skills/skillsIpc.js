const debugLogger = require("../debugLogger");
const { isSkillFolderName, writeErrorCode } = require("./skillLibrary");

const INVALID = { ok: false, error: "invalid" };
const UNAVAILABLE = { ok: false, error: "unavailable" };

function isUploadItem(item) {
  return Boolean(item) && typeof item.fileName === "string" && item.data instanceof Uint8Array;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isCreateInput(input) {
  return (
    Boolean(input) &&
    ["title", "description", "instructions"].every((key) => typeof input[key] === "string") &&
    Array.isArray(input.files) &&
    input.files.every(isUploadItem)
  );
}

const isOptional = (value, type) => value === undefined || typeof value === type;

function isModelRef(ref) {
  return (
    Boolean(ref) &&
    isSkillFolderName(ref.name) &&
    isOptional(ref.builtin, "boolean") &&
    isOptional(ref.file, "string") &&
    isOptional(ref.withFiles, "boolean")
  );
}

const isProposalFiles = (files) =>
  Array.isArray(files) &&
  files.every((file) => typeof file?.path === "string" && typeof file?.content === "string");

function isProposal(proposal) {
  return (
    Boolean(proposal) &&
    ["title", "description", "instructions"].every((key) => typeof proposal[key] === "string") &&
    isProposalFiles(proposal.files)
  );
}

function isUpdate(update) {
  return (
    Boolean(update) &&
    isSkillFolderName(update.name) &&
    isOptional(update.description, "string") &&
    isOptional(update.instructions, "string") &&
    isProposalFiles(update.files)
  );
}

function isProposalRequest(request) {
  if (request?.kind === "create") return isProposal(request.proposal);
  return request?.kind === "update" && isUpdate(request.update);
}

// Every handler checks its arguments before the library runs, and every write tells each
// window to reload its list.
function registerSkillsIpc({ ipcMain, library, shell, broadcast }) {
  const changed = () => broadcast("skills-changed");

  const saved = (result) => {
    if (!result) return INVALID;
    if (result.problems) return { ok: false, problems: result.problems };
    changed();
    return { ok: true, ...result };
  };

  // A window's previewed uploads are let go when it closes, crashes or reloads, since the
  // screen holding them can't let go then. Each window's count of those tells a preview
  // still being read that its window went away meanwhile.
  const releases = new Map();
  const releaseWhenGone = (sender) => {
    const { id } = sender;
    if (releases.has(id)) return;
    releases.set(id, 0);
    const release = () => {
      releases.set(id, releases.get(id) + 1);
      library.discardUploadsFrom(id);
    };
    sender.once("destroyed", () => {
      releases.delete(id);
      library.discardUploadsFrom(id);
    });
    sender.on("render-process-gone", release);
    // A main-frame navigation, such as a reload, replaces the renderer that held them.
    sender.on("did-start-navigation", (details) => {
      if (details?.isMainFrame && !details.isSameDocument) release();
    });
  };

  ipcMain.handle("skills-list", () => ({ skills: library.scan() }));

  ipcMain.handle("skills-get", (_event, name) =>
    isSkillFolderName(name) ? library.get(name) : null
  );

  ipcMain.handle("skills-read-file", (_event, name, relPath) => {
    if (!isSkillFolderName(name) || typeof relPath !== "string") return null;
    const text = library.readFile(name, relPath);
    return text === null ? null : { text };
  });

  ipcMain.handle("skills-set-enabled", (_event, name, enabled) => {
    if (!isSkillFolderName(name) || typeof enabled !== "boolean") return INVALID;
    try {
      if (!library.setEnabled(name, enabled)) return INVALID;
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
    changed();
    return { ok: true };
  });

  ipcMain.handle("skills-uninstall", (_event, name) => {
    if (!isSkillFolderName(name)) return INVALID;
    try {
      library.uninstall(name);
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
    changed();
    return { ok: true };
  });

  ipcMain.handle("skills-reveal", (_event, name) => {
    const folder = isSkillFolderName(name) ? library.skillDir(name) : null;
    if (!folder) return { ok: false };
    shell.showItemInFolder(folder);
    return { ok: true };
  });

  // Files cross as bytes and come back as one-time tokens, so what installs is exactly
  // what the user saw previewed.
  ipcMain.handle("skills-preview-upload", async (event, items) => {
    if (!Array.isArray(items) || !items.every(isUploadItem)) return INVALID;
    const { sender } = event;
    releaseWhenGone(sender);
    const released = releases.get(sender.id);
    const previews = await library.previewUploads(items, sender.id);
    // Its window went away while these were read, so nothing is left to install or free them.
    if (releases.get(sender.id) !== released) {
      library.discardUploads(previews.flatMap((preview) => (preview.token ? [preview.token] : [])));
    }
    return { items: previews };
  });

  ipcMain.handle("skills-discard-uploads", (_event, tokens) => {
    if (!isStringArray(tokens)) return INVALID;
    library.discardUploads(tokens);
    return { ok: true };
  });

  ipcMain.handle("skills-commit-upload", (_event, request) => {
    if (!isStringArray(request?.tokens) || !isStringArray(request?.replace)) return INVALID;
    const result = library.commitUploads({ tokens: request.tokens, replace: request.replace });
    if (result.installed.length > 0) changed();
    return result;
  });

  ipcMain.handle("skills-create", (_event, input) => {
    if (!isCreateInput(input)) return INVALID;
    try {
      return saved(library.create(input));
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
  });

  ipcMain.handle("skills-add-recommended", (_event, id, copy) => {
    if (
      !isSkillFolderName(id) ||
      typeof copy?.title !== "string" ||
      typeof copy?.description !== "string"
    ) {
      return INVALID;
    }
    try {
      return saved(
        library.addRecommended(id, { title: copy.title, description: copy.description })
      );
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
  });

  // A read or check the library can't finish answers as one that found nothing, so the chat
  // says the skill couldn't be read or checked rather than showing Electron's error text.
  ipcMain.handle("skills-read-for-model", (_event, ref) => {
    if (!isModelRef(ref)) return null;
    try {
      return library.readForModel(ref);
    } catch (error) {
      debugLogger.warn(
        "Could not read a skill for the assistant",
        { error: error.message },
        "skills"
      );
      return null;
    }
  });

  ipcMain.handle("skills-check-proposal", (_event, request) => {
    if (!isProposalRequest(request)) return INVALID;
    try {
      return library.checkProposal(request) ?? INVALID;
    } catch (error) {
      debugLogger.warn("Could not check a skill proposal", { error: error.message }, "skills");
      return INVALID;
    }
  });

  ipcMain.handle("skills-save-proposal", (_event, proposal) => {
    if (!isProposal(proposal)) return INVALID;
    try {
      return saved(library.saveProposal(proposal));
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
  });

  ipcMain.handle("skills-apply-update", (_event, update) => {
    if (!isUpdate(update)) return INVALID;
    try {
      return saved(library.applyUpdate(update));
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
  });

  ipcMain.handle("skills-undo", (_event, name, versionId) => {
    if (!isSkillFolderName(name) || typeof versionId !== "string" || !/^\d+$/.test(versionId)) {
      return INVALID;
    }
    try {
      if (!library.undo(name, versionId)) return INVALID;
    } catch (error) {
      return { ok: false, error: writeErrorCode(error) };
    }
    changed();
    return { ok: true };
  });

  // Bookkeeping, not a change to any skill, so the windows aren't told. Last use only orders
  // the skills offered to the assistant, so a stamp that can't be saved is let go.
  ipcMain.handle("skills-mark-used", (_event, name) => {
    if (!isSkillFolderName(name)) return;
    try {
      library.markUsed(name);
    } catch (error) {
      debugLogger.warn("Could not stamp a skill's last use", { error: error.message }, "skills");
    }
  });

  // Cloud backup, driven by the renderer's SyncService as for snippets. A pull tells the
  // windows once, at its end, through skills-broadcast-updated. A step that fails answers as
  // one and is logged, as the assistant's channels do; SyncService tries it again next pass.
  const { database } = library;
  const isCloudEntry = (entry) => typeof entry?.name === "string";
  const NOT_SAVED = { success: false };
  const answering = (failure, failed, run) => {
    try {
      return run();
    } catch (error) {
      debugLogger.warn(failure, { error: error.message }, "skills");
      return typeof failed === "function" ? failed(error) : failed;
    }
  };
  ipcMain.handle("skills-get-pending", () =>
    answering("Could not list skills to back up", [], () => {
      // A rescan first, so an edit or removal made outside the app is sent too.
      library.scan();
      return database.getPendingSkills();
    })
  );
  ipcMain.handle("skills-get-pending-deletes", () =>
    answering("Could not list skill removals to back up", [], () =>
      database.getPendingSkillDeletes()
    )
  );
  ipcMain.handle("skills-export-for-cloud", (_event, name) =>
    isSkillFolderName(name)
      ? answering("Could not read a skill to back up", null, () => library.exportForCloud(name))
      : null
  );
  // Not null when the lookup fails: null means this computer has no such skill.
  ipcMain.handle("skills-get-for-cloud-merge", (_event, entry) =>
    isCloudEntry(entry)
      ? answering("Could not look up a skill from Cloud backup", UNAVAILABLE, () =>
          database.getSkillForCloudMerge(entry)
        )
      : null
  );
  // Not false when the write fails: false means the entry was skipped for good.
  ipcMain.handle("skills-apply-from-cloud", (_event, entry) =>
    isCloudEntry(entry)
      ? answering(
          "Could not write a skill from Cloud backup",
          (error) => ({ ok: false, error: writeErrorCode(error) }),
          () => library.applyFromCloud(entry)
        )
      : false
  );
  ipcMain.handle(
    "skills-mark-synced",
    (_event, name, cloudId, serverUpdatedAt, expectedHash, expectedEnabled) => {
      if (!isSkillFolderName(name) || typeof cloudId !== "string") return null;
      // Nothing marked, so the push checks whether the skill is still here, as for an edit.
      return answering("Could not mark a skill backed up", { ...NOT_SAVED, changes: 0 }, () =>
        database.markSkillSynced(name, cloudId, serverUpdatedAt, expectedHash, expectedEnabled)
      );
    }
  );
  ipcMain.handle("skills-hard-delete", (_event, name) =>
    isSkillFolderName(name)
      ? answering("Could not forget a removed skill", NOT_SAVED, () =>
          database.hardDeleteSkillState(name)
        )
      : null
  );
  ipcMain.handle("skills-clear-cloud-id", (_event, name) =>
    isSkillFolderName(name)
      ? answering("Could not reset a skill's backup", NOT_SAVED, () =>
          database.clearSkillCloudId(name)
        )
      : null
  );
  ipcMain.handle("skills-broadcast-updated", () => changed());
}

module.exports = { registerSkillsIpc };
