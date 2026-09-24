class LocalModelDownloadStatus {
  constructor() {
    this.downloads = new Map();
    this.sequence = 0;
  }

  _key(modelType, modelId) {
    return `${modelType}:${modelId}`;
  }

  start(modelType, modelId) {
    const key = this._key(modelType, modelId);
    const existing = this.downloads.get(key);
    if (existing) return existing;

    const status = {
      modelType,
      modelId,
      phase: "downloading",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      sequence: ++this.sequence,
    };
    this.downloads.set(key, status);
    return status;
  }

  has(modelType, modelId) {
    return this.downloads.has(this._key(modelType, modelId));
  }

  update(modelType, modelId, updates) {
    const key = this._key(modelType, modelId);
    const current = this.downloads.get(key) || this.start(modelType, modelId);
    const status = {
      ...current,
      ...updates,
      modelType,
      modelId,
      sequence: ++this.sequence,
    };
    this.downloads.set(key, status);
    return status;
  }

  finish(modelType, modelId) {
    const key = this._key(modelType, modelId);
    const current = this.downloads.get(key);
    this.downloads.delete(key);
    return current ? { ...current, sequence: ++this.sequence } : null;
  }

  getActiveDownloads() {
    return Array.from(this.downloads.values());
  }
}

module.exports = LocalModelDownloadStatus;
