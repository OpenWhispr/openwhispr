const crypto = require("crypto");
const { batchBlocks } = require("./notionBlockConverter");
const { buildPublicationPayload } = require("./notionExporter");
const { findTitleProperty } = require("./notionClient");

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(payload, destinationId) {
  return crypto
    .createHash("sha256")
    .update(stableStringify({ destinationId, payload }))
    .digest("hex");
}

function safeError(error) {
  return {
    code: error?.code || "PUBLISH_FAILED",
    message: error?.message || "Publishing to Notion failed",
    retryable: error?.retryable === true,
    status: Number(error?.status) || 0,
    outcomeUnknown: error?.outcomeUnknown === true,
  };
}

function applyDraft(note, draft) {
  if (!draft || typeof draft !== "object") return note;
  const next = { ...note };
  const fields = [
    ["title", "title", 2000],
    ["content", "content", 5_000_000],
    ["enhancedContent", "enhanced_content", 5_000_000],
    ["transcript", "transcript", 10_000_000],
  ];
  for (const [inputKey, noteKey, maxLength] of fields) {
    if (!Object.prototype.hasOwnProperty.call(draft, inputKey)) continue;
    const value = draft[inputKey];
    if (value !== null && typeof value !== "string") {
      throw new TypeError(`Invalid Notion draft ${inputKey}`);
    }
    if (typeof value === "string" && value.length > maxLength) {
      throw new RangeError(`Notion draft ${inputKey} is too large`);
    }
    next[noteKey] = value;
  }
  return next;
}

function requiresReauth(error) {
  const code = String(error?.code || "").toLowerCase();
  return code === "invalid_grant" || code === "unauthorized" || error?.status === 401;
}

class NotionPublicationService {
  constructor(databaseManager, notionClient) {
    this.databaseManager = databaseManager;
    this.notionClient = notionClient;
    this.activeNotes = new Set();
  }

  getStatus(noteId) {
    return this.databaseManager.getLatestNotionPublication(noteId);
  }

  preview(noteId, options = {}) {
    const storedNote = this.databaseManager.getNote(noteId);
    if (!storedNote) throw new Error("Note not found");
    const note = applyDraft(storedNote, options.draft);
    const destination = options.destinationId
      ? this.databaseManager.getNotionDestinationById(options.destinationId)
      : this.databaseManager.getNotionDestination();
    if (!destination) throw new Error("Choose a Notion destination first");

    const payload = buildPublicationPayload(note, {
      layoutKey: options.layoutKey || destination.layout_key,
      contentSource: options.contentSource,
      includeTranscript:
        options.includeTranscript === undefined
          ? destination.include_transcript === 1
          : options.includeTranscript,
    });
    const hash = contentHash(payload, destination.id);
    const duplicate = this.databaseManager.findPublishedNotionPublication(
      note.id,
      destination.id,
      hash
    );
    return {
      destination,
      payload,
      contentHash: hash,
      duplicate,
      preview: payload.blocks
        .flatMap((block) => block[block.type]?.rich_text || [])
        .map((text) => text.text?.content || "")
        .join("\n")
        .slice(0, 1200),
    };
  }

  async publish(noteId, options = {}) {
    if (this.activeNotes.has(noteId)) {
      return {
        success: false,
        code: "ALREADY_PUBLISHING",
        error: "This note is already publishing",
      };
    }
    this.activeNotes.add(noteId);
    let publication = null;
    let pageId = null;

    try {
      const { destination, payload, contentHash: hash, duplicate } = this.preview(noteId, options);
      if (duplicate && options.allowDuplicate !== true) {
        return { success: false, code: "DUPLICATE", duplicate };
      }

      const uncertain =
        options.allowDuplicate === true
          ? null
          : this.databaseManager.findUncertainNotionPublication(noteId, destination.id, hash);
      if (uncertain) {
        return {
          success: false,
          code: "OUTCOME_UNKNOWN",
          error:
            "A previous publish may have reached Notion. Check the destination before publishing another copy.",
          publication: uncertain,
          pageUrl: uncertain.notion_page_url || undefined,
        };
      }

      publication =
        options.allowDuplicate === true
          ? null
          : this.databaseManager.findResumableNotionPublication(noteId, destination.id, hash);
      if (!publication) {
        publication = this.databaseManager.createNotionPublication({
          noteId,
          clientNoteId: payload.clientNoteId,
          destinationId: destination.id,
          contentHash: hash,
        });
      }

      this.databaseManager.updateNotionPublication(publication.id, {
        status: "publishing",
        attemptCount: Number(publication.attempt_count || 0) + 1,
        lastError: null,
      });

      const connection = this.databaseManager.getNotionConnection(destination.connection_id);
      if (!connection) throw new Error("Notion is not connected");
      pageId = publication.notion_page_id;
      let pageUrl = publication.notion_page_url;

      if (!pageId) {
        const schema = JSON.parse(destination.schema_snapshot || "{}");
        const titleProperty = findTitleProperty(schema);
        const page = await this.notionClient.createPage(connection.id, {
          dataSourceId: destination.data_source_id,
          titleProperty: titleProperty.name,
          title: payload.title,
        });
        pageId = page.id;
        pageUrl = page.url;
        this.databaseManager.updateNotionPublication(publication.id, {
          notionPageId: pageId,
          notionPageUrl: pageUrl,
          nextBlockIndex: 0,
        });
      }

      let nextBlockIndex = Number(publication.next_block_index || 0);
      const remaining = payload.blocks.slice(nextBlockIndex);
      for (const batch of batchBlocks(remaining)) {
        await this.notionClient.appendBlocks(connection.id, pageId, batch);
        nextBlockIndex += batch.length;
        this.databaseManager.updateNotionPublication(publication.id, { nextBlockIndex });
      }

      const published = this.databaseManager.updateNotionPublication(publication.id, {
        status: "published",
        nextBlockIndex,
        lastError: null,
      });
      return { success: true, publication: published, pageUrl };
    } catch (error) {
      const info = safeError(error);
      let failedPublication = publication;
      if (publication) {
        const status = requiresReauth(error) ? "needs_reauth" : pageId ? "partial" : "failed";
        failedPublication = this.databaseManager.updateNotionPublication(publication.id, {
          status,
          lastError: JSON.stringify(info),
        });
      }
      return {
        success: false,
        error: info.message,
        code: info.code,
        retryable: info.retryable,
        ...(info.outcomeUnknown && failedPublication
          ? {
              publication: failedPublication,
              pageUrl: failedPublication.notion_page_url || undefined,
            }
          : {}),
      };
    } finally {
      this.activeNotes.delete(noteId);
    }
  }
}

module.exports = {
  NotionPublicationService,
  applyDraft,
  contentHash,
  requiresReauth,
  stableStringify,
};
