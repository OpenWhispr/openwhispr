const { QdrantClient } = require("@qdrant/js-client-rest");
const localEmbeddings = require("./localEmbeddings");
const { LocalEmbeddings } = localEmbeddings;
const debugLogger = require("./debugLogger");
const { chunkConversation } = require("./conversationChunker");

class VectorIndex {
  constructor() {
    this.client = null;
    this.collectionName = "notes";
    this.conversationChunksCollection = "conversation_chunks";
  }

  init(port) {
    this.client = new QdrantClient({ host: "127.0.0.1", port });
  }

  async ensureCollection() {
    if (!this.client) return;
    try {
      await this.client.getCollection(this.collectionName);
    } catch {
      try {
        await this.client.createCollection(this.collectionName, {
          vectors: { size: 384, distance: "Cosine" },
        });
      } catch (err) {
        debugLogger.error("Failed to create Qdrant collection", { error: err.message });
      }
    }
  }

  async upsertNote(noteId, text) {
    if (!this.client) return;
    try {
      const vector = await localEmbeddings.embedText(text);
      await this.client.upsert(this.collectionName, {
        points: [{ id: noteId, vector: Array.from(vector), payload: {} }],
      });
    } catch (err) {
      debugLogger.debug("Vector index upsert failed", { noteId, error: err.message });
    }
  }

  async deleteNote(noteId) {
    if (!this.client) return;
    try {
      await this.client.delete(this.collectionName, { points: [noteId] });
    } catch (err) {
      debugLogger.debug("Vector index delete failed", { noteId, error: err.message });
    }
  }

  async search(queryText, limit = 5) {
    if (!this.client) return [];
    try {
      const vector = await localEmbeddings.embedText(queryText);
      const results = await this.client.search(this.collectionName, {
        vector: Array.from(vector),
        limit,
      });
      return results.map((r) => ({ noteId: r.id, score: r.score }));
    } catch (err) {
      debugLogger.debug("Vector search failed", { error: err.message });
      return [];
    }
  }

  async reindexAll(notes, onProgress) {
    if (!this.client) return;
    const BATCH_SIZE = 50;
    for (let i = 0; i < notes.length; i += BATCH_SIZE) {
      const batch = notes.slice(i, i + BATCH_SIZE);
      const texts = batch.map((n) =>
        LocalEmbeddings.noteEmbedText(n.title, n.content, n.enhanced_content)
      );
      try {
        const vectors = await localEmbeddings.embedTexts(texts);
        const points = batch.map((n, j) => ({
          id: n.id,
          vector: Array.from(vectors[j]),
          payload: {},
        }));
        await this.client.upsert(this.collectionName, { points });
      } catch (err) {
        debugLogger.debug("Vector reindex batch failed", { offset: i, error: err.message });
      }
      if (onProgress) onProgress(Math.min(i + BATCH_SIZE, notes.length), notes.length);
    }
  }

  async ensureConversationChunksCollection() {
    if (!this.client) return;
    try {
      await this.client.getCollection(this.conversationChunksCollection);
    } catch {
      try {
        await this.client.createCollection(this.conversationChunksCollection, {
          vectors: { size: 384, distance: "Cosine" },
        });
      } catch (err) {
        debugLogger.error("Failed to create conversation_chunks collection", {
          error: err.message,
        });
      }
    }
  }

  async upsertConversationChunks(conversationId, title, messages) {
    if (!this.client) return;
    try {
      await this.deleteConversationChunks(conversationId);
      const chunks = chunkConversation(title, messages);
      if (chunks.length === 0) return;

      const texts = chunks.map((c) => c.text);
      const vectors = await localEmbeddings.embedTexts(texts);
      const points = chunks.map((c, i) => ({
        id: conversationId * 1000 + c.chunkIndex,
        vector: Array.from(vectors[i]),
        payload: { conversation_id: conversationId, chunk_index: c.chunkIndex },
      }));
      await this.client.upsert(this.conversationChunksCollection, { points });
    } catch (err) {
      debugLogger.debug("Conversation chunks upsert failed", {
        conversationId,
        error: err.message,
      });
    }
  }

  async deleteConversationChunks(conversationId) {
    if (!this.client) return;
    try {
      await this.client.delete(this.conversationChunksCollection, {
        filter: { must: [{ key: "conversation_id", match: { value: conversationId } }] },
      });
    } catch (err) {
      debugLogger.debug("Conversation chunks delete failed", {
        conversationId,
        error: err.message,
      });
    }
  }

  async searchConversations(queryText, limit = 10) {
    if (!this.client) return [];
    try {
      const vector = await localEmbeddings.embedText(queryText);
      const results = await this.client.search(this.conversationChunksCollection, {
        vector: Array.from(vector),
        limit: limit * 3,
      });

      const bestByConversation = new Map();
      for (const r of results) {
        if (r.score < 0.3) continue;
        const convId = r.payload.conversation_id;
        if (!bestByConversation.has(convId) || r.score > bestByConversation.get(convId)) {
          bestByConversation.set(convId, r.score);
        }
      }

      return [...bestByConversation.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([conversationId, score]) => ({ conversationId, score }));
    } catch (err) {
      debugLogger.debug("Conversation search failed", { error: err.message });
      return [];
    }
  }

  async reindexAllConversations(conversations, onProgress) {
    if (!this.client) return;
    const BATCH_SIZE = 50;
    for (let i = 0; i < conversations.length; i += BATCH_SIZE) {
      const batch = conversations.slice(i, i + BATCH_SIZE);
      for (const conv of batch) {
        try {
          const chunks = chunkConversation(conv.title, conv.messages);
          if (chunks.length === 0) continue;

          const texts = chunks.map((c) => c.text);
          const vectors = await localEmbeddings.embedTexts(texts);
          const points = chunks.map((c, j) => ({
            id: conv.id * 1000 + c.chunkIndex,
            vector: Array.from(vectors[j]),
            payload: { conversation_id: conv.id, chunk_index: c.chunkIndex },
          }));
          await this.client.upsert(this.conversationChunksCollection, { points });
        } catch (err) {
          debugLogger.debug("Conversation reindex failed", {
            conversationId: conv.id,
            error: err.message,
          });
        }
      }
      if (onProgress)
        onProgress(Math.min(i + BATCH_SIZE, conversations.length), conversations.length);
    }
  }

  isReady() {
    return this.client !== null;
  }
}

module.exports = new VectorIndex();
