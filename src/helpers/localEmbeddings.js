const fs = require("fs");
const os = require("os");
const path = require("path");
const debugLogger = require("./debugLogger");

const MAX_TOKENS = 256;
const EMBEDDING_DIM = 384;

const MODEL_SUBDIR = "all-MiniLM-L6-v2";

class LocalEmbeddings {
  constructor() {
    this.session = null;
    this.tokenizer = null;
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

  async _ensureLoaded() {
    if (this.session && this.tokenizer) return;

    if (!this.isAvailable()) {
      throw new Error("Embedding model not found. Run: node scripts/download-minilm.js");
    }

    debugLogger.debug("local-embeddings loading model", { modelDir: this.modelDir });

    const tokenizerPath = path.join(this.modelDir, "tokenizer.json");
    const tokenizerData = JSON.parse(fs.readFileSync(tokenizerPath, "utf-8"));
    this.tokenizer = this._buildTokenizer(tokenizerData);

    const ort = require("onnxruntime-node");
    const modelPath = path.join(this.modelDir, "model.onnx");
    this.session = await ort.InferenceSession.create(modelPath);

    debugLogger.debug("local-embeddings model loaded");
  }

  _buildTokenizer(tokenizerData) {
    const tokenToId = new Map();
    for (const [token, id] of Object.entries(tokenizerData.model.vocab)) {
      tokenToId.set(token, id);
    }

    return {
      tokenToId,
      clsId: tokenToId.get("[CLS]") ?? 101,
      sepId: tokenToId.get("[SEP]") ?? 102,
      unkId: tokenToId.get("[UNK]") ?? 100,
    };
  }

  _tokenize(text) {
    const { tokenToId, clsId, sepId, unkId } = this.tokenizer;
    const words = text.toLowerCase().match(/[a-z0-9]+|[^\s\w]/g) || [];
    const tokenIds = [clsId];

    for (const word of words) {
      if (tokenIds.length >= MAX_TOKENS - 1) break;

      if (tokenToId.has(word)) {
        tokenIds.push(tokenToId.get(word));
        continue;
      }

      // WordPiece: greedily match longest subword
      let start = 0;
      while (start < word.length) {
        if (tokenIds.length >= MAX_TOKENS - 1) break;

        let end = word.length;
        let matched = false;

        while (end > start) {
          const subword = start === 0 ? word.slice(start, end) : `##${word.slice(start, end)}`;
          if (tokenToId.has(subword)) {
            tokenIds.push(tokenToId.get(subword));
            start = end;
            matched = true;
            break;
          }
          end--;
        }

        if (!matched) {
          tokenIds.push(unkId);
          start++;
        }
      }
    }

    tokenIds.push(sepId);

    const length = tokenIds.length;
    const inputIds = new BigInt64Array(length);
    const attentionMask = new BigInt64Array(length);
    const tokenTypeIds = new BigInt64Array(length);

    for (let i = 0; i < length; i++) {
      inputIds[i] = BigInt(tokenIds[i]);
      attentionMask[i] = 1n;
      tokenTypeIds[i] = 0n;
    }

    return { inputIds, attentionMask, tokenTypeIds, length };
  }

  async embedText(text) {
    await this._ensureLoaded();

    const { inputIds, attentionMask, tokenTypeIds, length } = this._tokenize(text);

    const ort = require("onnxruntime-node");
    const feeds = {
      input_ids: new ort.Tensor("int64", inputIds, [1, length]),
      attention_mask: new ort.Tensor("int64", attentionMask, [1, length]),
      token_type_ids: new ort.Tensor("int64", tokenTypeIds, [1, length]),
    };

    const results = await this.session.run(feeds);
    const output = results.last_hidden_state ?? results.output_0;

    return this._meanPoolAndNormalize(output.data, length, EMBEDDING_DIM);
  }

  async embedTexts(texts) {
    const results = [];
    for (const text of texts) {
      results.push(await this.embedText(text));
    }
    return results;
  }

  // Mean pooling over token embeddings, then L2 normalize to unit vector
  _meanPoolAndNormalize(data, tokenCount, dim) {
    const embedding = new Float32Array(dim);

    for (let t = 0; t < tokenCount; t++) {
      const offset = t * dim;
      for (let d = 0; d < dim; d++) {
        embedding[d] += data[offset + d];
      }
    }

    for (let d = 0; d < dim; d++) {
      embedding[d] /= tokenCount;
    }

    let norm = 0;
    for (let d = 0; d < dim; d++) {
      norm += embedding[d] * embedding[d];
    }
    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let d = 0; d < dim; d++) {
        embedding[d] /= norm;
      }
    }

    return embedding;
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
