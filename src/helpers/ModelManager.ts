import path from "path";
import { spawn } from "child_process";
import fs from "fs";
import { promises as fsPromises } from "fs";
import { app } from "electron";
import { modelRegistry } from "../models/ModelRegistry";
import { inferenceConfig } from "../config/InferenceConfig";
import { MODEL_CONSTRAINTS } from "../config/constants";
import { parseLlamaCppOutput } from "../utils/llamaOutputParser";
const { downloadFile: runtimeDownloadFile } = require("./downloadUtils");

// Error types
export class ModelError extends Error {
  constructor(
    message: string,
    public code: string,
    public details: Record<string, any> = {}
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export class ModelNotFoundError extends ModelError {
  constructor(modelId: string) {
    super(`Model ${modelId} not found`, "MODEL_NOT_FOUND", { modelId });
  }
}

export interface DownloadProgress {
  modelId: string;
  progress: number;
  downloadedSize: number;
  totalSize: number;
}

class ModelManager {
  private modelsDir: string;
  private llamaCppPath: string | null = null;
  private downloadProgress = new Map<string, DownloadProgress>();
  private activeDownloads = new Map<string, boolean>();

  constructor() {
    this.modelsDir = this.getModelsDir();
  }

  private getModelsDir(): string {
    const homeDir = app.getPath("home");
    return path.join(homeDir, ".cache", "openwhispr", "models");
  }

  async ensureModelsDir(): Promise<void> {
    await fsPromises.mkdir(this.modelsDir, { recursive: true });
  }

  async isModelDownloaded(modelId: string): Promise<boolean> {
    const modelInfo = modelRegistry.getModel(modelId);
    if (!modelInfo) return false;

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);
    try {
      const stats = await fsPromises.stat(modelPath);
      return stats.size > MODEL_CONSTRAINTS.MIN_FILE_SIZE;
    } catch {
      return false;
    }
  }

  async downloadModel(
    modelId: string,
    onProgress?: (progress: number, downloaded: number, total: number) => void
  ): Promise<string> {
    if (this.activeDownloads.has(modelId)) {
      throw new ModelError("Download already in progress", "DOWNLOAD_IN_PROGRESS", { modelId });
    }

    await this.ensureModelsDir();

    const modelInfo = modelRegistry.getModel(modelId);
    if (!modelInfo) {
      throw new ModelNotFoundError(modelId);
    }

    const { model, provider } = modelInfo;
    const modelPath = path.join(this.modelsDir, model.fileName);

    if (await this.isModelDownloaded(modelId)) {
      return modelPath;
    }

    const downloadUrl = provider.getDownloadUrl(model);
    this.activeDownloads.set(modelId, true);

    try {
      await runtimeDownloadFile(downloadUrl, modelPath, {
        onProgress: (downloadedSize: number, totalSize: number) => {
          const progress = totalSize > 0 ? (downloadedSize / totalSize) * 100 : 0;
          this.downloadProgress.set(modelId, {
            modelId,
            progress,
            downloadedSize,
            totalSize,
          });
          onProgress?.(progress, downloadedSize, totalSize);
        },
      });

      const stats = await fsPromises.stat(modelPath);
      if (stats.size < MODEL_CONSTRAINTS.MIN_FILE_SIZE) {
        await fsPromises.unlink(modelPath).catch(() => {});
        throw new ModelError("Downloaded file appears to be corrupted", "DOWNLOAD_CORRUPTED", {
          size: stats.size,
        });
      }

      return modelPath;
    } finally {
      this.downloadProgress.delete(modelId);
      this.activeDownloads.delete(modelId);
    }
  }

  async deleteModel(modelId: string): Promise<void> {
    const modelInfo = modelRegistry.getModel(modelId);
    if (!modelInfo) return;

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);
    try {
      await fsPromises.unlink(modelPath);
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        throw new ModelError(`Failed to delete model`, "DELETE_ERROR", {
          modelId,
          error: error.message,
        });
      }
    }
  }

  async deleteAllModels(): Promise<void> {
    try {
      await fsPromises.rm(this.modelsDir, { recursive: true, force: true });
    } catch (error: any) {
      throw new ModelError(
        `Failed to delete models directory: ${error.message}`,
        "DELETE_ALL_ERROR",
        { error: error.message }
      );
    } finally {
      await this.ensureModelsDir();
    }
  }

  getDownloadProgress(modelId: string): DownloadProgress | undefined {
    return this.downloadProgress.get(modelId);
  }

  async ensureLlamaCpp(): Promise<boolean> {
    if (this.llamaCppPath) return true;

    // Dynamic import to avoid loading in frontend
    const llamaCppInstaller = require("./llamaCppInstaller").default;

    if (await llamaCppInstaller.isInstalled()) {
      this.llamaCppPath = llamaCppInstaller.getInstalledBinaryPath();
      return true;
    }

    const paths = [
      "llama-cli",
      "/usr/local/bin/llama-cli",
      "/opt/homebrew/bin/llama-cli",
      path.join(app.getPath("home"), ".local", "bin", "llama-cli"),
    ];

    for (const p of paths) {
      try {
        if (p === "llama-cli") {
          await new Promise((resolve, reject) => {
            spawn("which", ["llama-cli"]).on("close", (code) =>
              code === 0 ? resolve(p) : reject()
            );
          });
          this.llamaCppPath = p;
          return true;
        } else {
          await fsPromises.access(p, fs.constants.X_OK);
          this.llamaCppPath = p;
          return true;
        }
      } catch {
        // Continue to next path
      }
    }

    throw new ModelError(
      "llama.cpp not found. Please install it from the Local AI Models settings.",
      "LLAMA_CPP_NOT_FOUND"
    );
  }

  async runInference(modelId: string, prompt: string, options: any = {}): Promise<string> {
    await this.ensureLlamaCpp();

    const modelInfo = modelRegistry.getModel(modelId);
    if (!modelInfo) {
      throw new ModelNotFoundError(modelId);
    }

    const { model, provider } = modelInfo;
    const modelPath = path.join(this.modelsDir, model.fileName);

    if (!(await this.isModelDownloaded(modelId))) {
      throw new ModelError(`Model ${modelId} is not downloaded`, "MODEL_NOT_DOWNLOADED");
    }

    const config = inferenceConfig.getConfig();
    const finalOptions = { ...config, ...options };
    const formattedPrompt = provider.formatPrompt(prompt, "");

    const args = [
      "-m",
      modelPath,
      "-p",
      formattedPrompt,
      "-n",
      finalOptions.maxTokens.toString(),
      "--temp",
      finalOptions.temperature.toString(),
      "--top-k",
      finalOptions.topK.toString(),
      "--top-p",
      finalOptions.topP.toString(),
      "--repeat-penalty",
      finalOptions.repeatPenalty.toString(),
      "--ctx-size",
      finalOptions.contextSize.toString(),
      "--no-display-prompt",
      "-t",
      finalOptions.threads.toString(),
    ];

    return new Promise((resolve, reject) => {
      const llamaProcess = spawn(this.llamaCppPath!, args);
      let output = "";
      let error = "";

      llamaProcess.stdout.on("data", (data) => {
        output += data.toString();
      });

      llamaProcess.stderr.on("data", (data) => {
        error += data.toString();
      });

      llamaProcess.on("close", (code) => {
        if (code === 0) {
          resolve(parseLlamaCppOutput(output));
        } else {
          reject(new ModelError(`Inference failed: ${error}`, "INFERENCE_ERROR"));
        }
      });

      setTimeout(() => {
        llamaProcess.kill();
        reject(new ModelError("Inference timeout", "INFERENCE_TIMEOUT"));
      }, finalOptions.timeout);
    });
  }

  async getModelsWithStatus() {
    const allModels = modelRegistry.getAllModels();

    return Promise.all(
      allModels.map(async (model) => ({
        ...model,
        isDownloaded: await this.isModelDownloaded(model.id),
        downloadProgress: this.downloadProgress.get(model.id)?.progress || 0,
        isDownloading: this.activeDownloads.has(model.id),
      }))
    );
  }
}

export default new ModelManager();
