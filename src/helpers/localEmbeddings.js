const fs = require("fs");
const os = require("os");
const path = require("path");
const debugLogger = require("./debugLogger");
const onnxWorkerClient = require("./onnxWorkerClient");

const MODEL_SUBDIR = "all-MiniLM-L6-v2";

class LocalEmbeddings {
  constructor() {
    this.loadPromise = null;
    this.modelDir = this._resolveModelDir();
  }

  _resolveModelDir() {
    const cacheDir = path.join(
      os.homedir(),
      ".cache",
      "openwhispr",
      "embedding-models",
      MODEL_SUBDIR
    );

    if (process.resourcesPath) {
      const bundled = path.join(process.resourcesPath, "bin", MODEL_SUBDIR);
      if (
        fs.existsSync(path.join(bundled, "model.onnx")) &&
        fs.existsSync(path.join(bundled, "tokenizer.json"))
      ) {
        return bundled;
      }
    }

    const projectBin = path.resolve(__dirname, "..", "..", "resources", "bin", MODEL_SUBDIR);
    if (
      fs.existsSync(path.join(projectBin, "model.onnx")) &&
      fs.existsSync(path.join(projectBin, "tokenizer.json"))
    ) {
      return projectBin;
    }

    return cacheDir;
  }

  isAvailable() {
    return (
      fs.existsSync(path.join(this.modelDir, "model.onnx")) &&
      fs.existsSync(path.join(this.modelDir, "tokenizer.json"))
    );
  }

  _ensureLoaded() {
    if (this.loadPromise) return this.loadPromise;
    if (!this.isAvailable()) {
      return Promise.reject(
        new Error("Embedding model not found. Run: node scripts/download-minilm.js")
      );
    }
    debugLogger.debug("local-embeddings loading model", { modelDir: this.modelDir });
    this.loadPromise = onnxWorkerClient
      .request("text.load", { modelDir: this.modelDir })
      .then(() => debugLogger.debug("local-embeddings model loaded"))
      .catch((err) => {
        this.loadPromise = null;
        throw err;
      });
    return this.loadPromise;
  }

  async embedText(text) {
    await this._ensureLoaded();
    const { embeddingBuffer } = await onnxWorkerClient.request("text.embed", { text });
    return new Float32Array(embeddingBuffer);
  }

  async embedTexts(texts) {
    const results = [];
    for (const text of texts) {
      results.push(await this.embedText(text));
    }
    return results;
  }

  static noteEmbedText(title, content, enhancedContent) {
    return `${title}\n${enhancedContent || content}`.slice(0, 1500);
  }

  async downloadModel() {
    if (this.isAvailable()) return;

    const { downloadFile } = require("./downloadUtils");
    const files = [
      {
        name: "model.onnx",
        url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
      },
      {
        name: "tokenizer.json",
        url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
      },
    ];

    fs.mkdirSync(this.modelDir, { recursive: true });

    for (const file of files) {
      const dest = path.join(this.modelDir, file.name);
      if (fs.existsSync(dest)) continue;
      debugLogger.debug("local-embeddings downloading", { file: file.name });
      await downloadFile(file.url, dest);
    }

    debugLogger.info("local-embeddings model downloaded", { modelDir: this.modelDir });
  }
}

const instance = new LocalEmbeddings();
module.exports = instance;
module.exports.LocalEmbeddings = LocalEmbeddings;
