const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");
const debugLogger = require("./debugLogger");

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const MAX_RICH_TEXT_LENGTH = 1900;
const MAX_BLOCKS_PER_REQUEST = 95;

function extractDatabaseId(input) {
  if (!input || typeof input !== "string") return "";
  const trimmed = input.trim();
  const match = trimmed.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (!match) return trimmed;
  const raw = match[1].replace(/-/g, "");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function chunkText(text, maxLen = MAX_RICH_TEXT_LENGTH) {
  if (!text) return [];
  const chunks = [];
  let remaining = String(text);
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  return chunks;
}

function textToParagraphBlocks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    for (const chunk of chunkText(line)) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: chunk } }],
        },
      });
    }
  }
  return blocks;
}

function buildNoteBlocks(note) {
  const blocks = [];
  const addSection = (heading, body) => {
    if (!body || !String(body).trim()) return;
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: heading } }],
      },
    });
    blocks.push(...textToParagraphBlocks(body));
  };

  addSection("Summary / Enhanced Notes", note.enhanced_content);
  addSection("Notes", note.content);
  addSection("Transcript", note.transcript);

  if (blocks.length === 0) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: "(Empty note)" } }],
      },
    });
  }
  return blocks;
}

class NotionStorageManager {
  constructor() {
    this._titlePropertyCache = new Map();
    this._queue = Promise.resolve();
    this._pendingNoteIds = new Set();
    this._lastError = null;
    this._lastSyncedAt = null;
  }

  _getConfigPath() {
    return path.join(app.getPath("userData"), "notion-storage.json");
  }

  _getMapPath() {
    return path.join(app.getPath("userData"), "notion-sync-map.json");
  }

  _encryptSecret(plain) {
    if (!plain) return "";
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return { encrypted: true, data: safeStorage.encryptString(plain).toString("base64") };
      }
    } catch {}
    return { encrypted: false, data: plain };
  }

  _decryptSecret(stored) {
    if (!stored) return "";
    if (typeof stored === "string") return stored;
    try {
      if (stored.encrypted && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(stored.data, "base64"));
      }
      return stored.data || "";
    } catch {
      return "";
    }
  }

  getConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._getConfigPath(), "utf8"));
      return {
        enabled: Boolean(raw.enabled),
        autoSync: raw.autoSync !== false,
        databaseId: raw.databaseId || "",
        apiKey: this._decryptSecret(raw.apiKey),
      };
    } catch {
      return { enabled: false, autoSync: true, databaseId: "", apiKey: "" };
    }
  }

  getPublicConfig() {
    const cfg = this.getConfig();
    return {
      enabled: cfg.enabled,
      autoSync: cfg.autoSync,
      databaseId: cfg.databaseId,
      hasApiKey: Boolean(cfg.apiKey),
      apiKeyMasked: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}...${cfg.apiKey.slice(-4)}` : "",
      lastError: this._lastError,
      lastSyncedAt: this._lastSyncedAt,
    };
  }

  saveConfig({ enabled, autoSync, databaseId, apiKey }) {
    const current = this.getConfig();
    const nextApiKey = apiKey !== undefined && apiKey !== "" ? String(apiKey).trim() : current.apiKey;
    const nextDbId = databaseId !== undefined ? extractDatabaseId(databaseId) : current.databaseId;
    const payload = {
      enabled: enabled !== undefined ? Boolean(enabled) : current.enabled,
      autoSync: autoSync !== undefined ? Boolean(autoSync) : current.autoSync,
      databaseId: nextDbId,
      apiKey: this._encryptSecret(nextApiKey),
    };
    fs.mkdirSync(path.dirname(this._getConfigPath()), { recursive: true });
    fs.writeFileSync(this._getConfigPath(), JSON.stringify(payload, null, 2), "utf8");
    this._titlePropertyCache.clear();
    this._lastError = null;
    return this.getPublicConfig();
  }

  _readMap() {
    try {
      return JSON.parse(fs.readFileSync(this._getMapPath(), "utf8"));
    } catch {
      return {};
    }
  }

  _writeMap(map) {
    fs.mkdirSync(path.dirname(this._getMapPath()), { recursive: true });
    fs.writeFileSync(this._getMapPath(), JSON.stringify(map, null, 2), "utf8");
  }

  async _notionFetch(endpoint, apiKey, options = {}) {
    const res = await fetch(`${NOTION_API_BASE}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {}
    if (!res.ok) {
      const msg = json.message || `Notion API error (${res.status})`;
      throw new Error(msg);
    }
    return json;
  }

  async testConnection(apiKeyOverride, databaseIdOverride) {
    const cfg = this.getConfig();
    const apiKey = (apiKeyOverride || cfg.apiKey || "").trim();
    const databaseId = extractDatabaseId(databaseIdOverride || cfg.databaseId || "");
    if (!apiKey || !databaseId) {
      return { ok: false, error: "API Key と Database ID の両方を入力してください。" };
    }
    try {
      const db = await this._notionFetch(`/databases/${databaseId}`, apiKey);
      const titleProp = Object.entries(db.properties || {}).find(([, v]) => v?.type === "title")?.[0] || "Name";
      const dbTitle = (db.title || []).map((t) => t.plain_text).join("") || "Untitled Database";
      this._titlePropertyCache.set(databaseId, titleProp);
      return { ok: true, databaseTitle: dbTitle, titlePropertyName: titleProp, databaseId };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  async _getTitlePropertyName(apiKey, databaseId) {
    if (this._titlePropertyCache.has(databaseId)) {
      return this._titlePropertyCache.get(databaseId);
    }
    const res = await this.testConnection(apiKey, databaseId);
    if (!res.ok) throw new Error(res.error);
    return res.titlePropertyName;
  }

  async syncNote(note) {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.apiKey || !cfg.databaseId || !note || !note.id) return null;

    try {
      const titleProp = await this._getTitlePropertyName(cfg.apiKey, cfg.databaseId);
      const titleText = (note.title && String(note.title).trim()) || `Note ${new Date(note.created_at || Date.now()).toLocaleString()}`;
      const blocks = buildNoteBlocks(note);
      const map = this._readMap();
      const existing = map[note.id];

      if (existing?.notionPageId) {
        await this._notionFetch(`/pages/${existing.notionPageId}`, cfg.apiKey, {
          method: "PATCH",
          body: JSON.stringify({
            properties: {
              [titleProp]: { title: [{ type: "text", text: { content: titleText.slice(0, 2000) } }] },
            },
          }),
        });
        const children = await this._notionFetch(`/blocks/${existing.notionPageId}/children?page_size=100`, cfg.apiKey);
        for (const blk of children.results || []) {
          await this._notionFetch(`/blocks/${blk.id}`, cfg.apiKey, { method: "DELETE" });
        }
        for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
          await this._notionFetch(`/blocks/${existing.notionPageId}/children`, cfg.apiKey, {
            method: "PATCH",
            body: JSON.stringify({ children: blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST) }),
          });
        }
        map[note.id] = { notionPageId: existing.notionPageId, lastSyncedAt: new Date().toISOString() };
        this._writeMap(map);
        this._lastSyncedAt = map[note.id].lastSyncedAt;
        this._lastError = null;
        return existing.notionPageId;
      }

      const firstBatch = blocks.slice(0, MAX_BLOCKS_PER_REQUEST);
      const created = await this._notionFetch("/pages", cfg.apiKey, {
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: cfg.databaseId },
          properties: {
            [titleProp]: { title: [{ type: "text", text: { content: titleText.slice(0, 2000) } }] },
          },
          children: firstBatch,
        }),
      });
      for (let i = MAX_BLOCKS_PER_REQUEST; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
        await this._notionFetch(`/blocks/${created.id}/children`, cfg.apiKey, {
          method: "PATCH",
          body: JSON.stringify({ children: blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST) }),
        });
      }
      map[note.id] = { notionPageId: created.id, lastSyncedAt: new Date().toISOString() };
      this._writeMap(map);
      this._lastSyncedAt = map[note.id].lastSyncedAt;
      this._lastError = null;
      return created.id;
    } catch (err) {
      this._lastError = err.message || String(err);
      debugLogger.error("NotionStorage syncNote failed", { noteId: note.id, error: this._lastError });
      return null;
    }
  }

  async deleteNote(noteId) {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.apiKey || !noteId) return;
    const map = this._readMap();
    const existing = map[noteId];
    if (!existing?.notionPageId) return;
    try {
      await this._notionFetch(`/pages/${existing.notionPageId}`, cfg.apiKey, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });
      delete map[noteId];
      this._writeMap(map);
    } catch (err) {
      debugLogger.error("NotionStorage deleteNote failed", { noteId, error: err.message });
    }
  }

  queueNote(note) {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.autoSync || !note?.id) return;
    if (this._pendingNoteIds.has(note.id)) return;
    this._pendingNoteIds.add(note.id);
    this._queue = this._queue.then(async () => {
      this._pendingNoteIds.delete(note.id);
      await this.syncNote(note);
    });
  }

  async syncAllNotes(databaseManager) {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.apiKey || !cfg.databaseId) {
      return { ok: false, error: "Notion Storage が有効になっていないか、設定が不足しています。" };
    }
    try {
      const notes = databaseManager.db
        .prepare("SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC")
        .all();
      let synced = 0;
      let failed = 0;
      for (const note of notes) {
        const id = await this.syncNote(note);
        if (id) synced += 1;
        else failed += 1;
        await new Promise((r) => setTimeout(r, 350));
      }
      return { ok: true, total: notes.length, synced, failed };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }
}

module.exports = { NotionStorageManager, extractDatabaseId };
