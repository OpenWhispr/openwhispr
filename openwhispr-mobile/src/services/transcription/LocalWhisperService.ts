import { initWhisper, type WhisperContext } from 'whisper.rn';
import * as FileSystem from 'expo-file-system/legacy';
import { TranscriptionResponse } from '../../types';

export interface LocalModelInfo {
  name: string;
  size: number;
  downloaded: boolean;
  path?: string;
}

export class LocalWhisperService {
  private static whisperContext: WhisperContext | null = null;
  private static currentModel: string | null = null;
  private static operationChain: Promise<unknown> = Promise.resolve();
  private static activeModelDownloads = new Map<
    string,
    ReturnType<typeof FileSystem.createDownloadResumable>
  >();
  private static readonly maxThreads = 4;

  // Serializes every operation that touches the native context (init, release,
  // transcribe) so a model swap can never release the context out from under an
  // in-flight transcription, which would abort() the native runtime.
  private static runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation);
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private static async releaseContext(): Promise<void> {
    if (!this.whisperContext) {
      return;
    }

    await this.whisperContext.release();
    this.whisperContext = null;
    this.currentModel = null;
  }

  private static getModelsDir(): string {
    return `${FileSystem.documentDirectory}whisper-models/`;
  }

  static isAvailable(): boolean {
    try {
      return typeof initWhisper !== 'undefined';
    } catch {
      return false;
    }
  }

  private static async initializeModel(modelPath: string): Promise<void> {
    await this.releaseContext();

    this.whisperContext = await initWhisper({
      filePath: modelPath,
      // Force CPU inference. On iOS 26 the system revokes GPU access from
      // backgrounded apps mid-transcription; ggml-metal treats the failed Metal
      // command buffer as fatal and calls abort() (SIGABRT), which is uncatchable
      // from JS. See whisper.cpp issue #3531. Re-enable GPU once it's fixed upstream.
      useGpu: false,
    });
    this.currentModel = modelPath;
  }

  private static async ensureModelInitialized(modelPath: string): Promise<void> {
    if (this.whisperContext && this.currentModel === modelPath) {
      return;
    }
    await this.initializeModel(modelPath);
  }

  private static preferredModelsForLanguage(language = 'en'): string[] {
    const normalized = language.trim().toLowerCase();
    if (!normalized || normalized === 'auto') {
      return ['base', 'tiny'];
    }
    if (normalized.startsWith('en')) {
      return ['base.en', 'base', 'tiny.en', 'tiny'];
    }
    return ['base', 'tiny'];
  }

  static async getRecommendedModelForLanguage(language = 'en'): Promise<string> {
    const preferredModels = this.preferredModelsForLanguage(language);
    const availableModels = await this.getAvailableModels();
    return (
      preferredModels.find((modelName) =>
        availableModels.some((model) => model.name === modelName && model.downloaded),
      ) ?? preferredModels[0]
    );
  }

  static async prepareForLanguage(language = 'en'): Promise<void> {
    const modelName = await this.getRecommendedModelForLanguage(language);
    const models = await this.getAvailableModels();
    const model = models.find((candidate) => candidate.name === modelName);
    if (!model?.downloaded || !model.path) {
      return;
    }
    const modelPath = model.path;
    await this.runExclusive(() => this.ensureModelInitialized(modelPath));
  }

  static async transcribe(
    audioUri: string,
    options:
      | { modelName?: string; language?: string; wordTimestamps?: boolean; prompt?: string }
      | string = {},
    language: string = 'en',
  ): Promise<TranscriptionResponse> {
    // Back-compat: existing callers pass (uri, modelName, language) positionally.
    const opts =
      typeof options === 'string'
        ? {
            modelName: options,
            language,
            wordTimestamps: false,
            prompt: undefined as string | undefined,
          }
        : {
            modelName: options.modelName ?? 'base',
            language: options.language ?? language,
            wordTimestamps: options.wordTimestamps ?? false,
            prompt: options.prompt,
          };
    const modelName = opts.modelName;

    if (!this.isAvailable()) {
      throw new Error(
        'Local Whisper is not available. Build the app with `npx expo run:ios` to enable local transcription.',
      );
    }

    const models = await this.getAvailableModels();
    const model = models.find((m) => m.name === modelName);

    if (!model || !model.downloaded) {
      throw new Error(
        `Model "${modelName}" is not available. Please download it first from Settings.`,
      );
    }

    const modelsDir = this.getModelsDir();
    const dirInfo = await FileSystem.getInfoAsync(modelsDir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(modelsDir, { intermediates: true });
    }

    if (!model.path) {
      throw new Error(`Model path not found for "${modelName}". Please re-download the model.`);
    }

    const modelPath = model.path;

    return this.runExclusive(async () => {
      await this.ensureModelInitialized(modelPath);

      if (!this.whisperContext) {
        throw new Error('Failed to initialize Whisper context. Please try again.');
      }

      const startTime = Date.now();

      const { promise } = this.whisperContext.transcribe(audioUri, {
        language: opts.language,
        maxThreads: this.maxThreads,
        maxLen: opts.wordTimestamps ? 1 : 0,
        tokenTimestamps: opts.wordTimestamps,
        translate: false,
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
      });
      const result = await promise;

      const duration = (Date.now() - startTime) / 1000;

      return {
        text: result.result.trim(),
        duration,
        provider: 'local',
        processingMs: Date.now() - startTime,
        ...(opts.wordTimestamps ? { segments: result.segments } : {}),
      };
    });
  }

  static async getAvailableModels(): Promise<LocalModelInfo[]> {
    if (!this.isAvailable()) {
      return [];
    }

    const modelsDir = this.getModelsDir();
    const dirInfo = await FileSystem.getInfoAsync(modelsDir);

    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(modelsDir, { intermediates: true });
      return [];
    }

    const files = await FileSystem.readDirectoryAsync(modelsDir);
    const models: LocalModelInfo[] = [];

    for (const file of files) {
      if (file.endsWith('.bin')) {
        const filePath = `${modelsDir}${file}`;
        const fileInfo = await FileSystem.getInfoAsync(filePath);

        models.push({
          name: file.replace('.bin', ''),
          size: (fileInfo as any).size || 0,
          downloaded: true,
          path: filePath,
        });
      }
    }

    return models;
  }

  static async downloadModel(
    modelName: string,
    onProgress?: (progress: number) => void,
  ): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error(
        'Local Whisper is not available. Build the app with `npx expo run:ios` to enable it.',
      );
    }

    const modelsDir = this.getModelsDir();
    const dirInfo = await FileSystem.getInfoAsync(modelsDir);

    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(modelsDir, { intermediates: true });
    }

    const modelUrls: Record<string, string> = {
      tiny: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
      'tiny.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
      base: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
      'base.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
      small: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
      'small.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
      medium: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
      'medium.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin',
    };

    const url = modelUrls[modelName];
    if (!url) {
      throw new Error(
        `Unknown model: ${modelName}. Available models: ${Object.keys(modelUrls).join(', ')}`,
      );
    }

    const destinationPath = `${modelsDir}${modelName}.bin`;

    const downloadResumable = FileSystem.createDownloadResumable(
      url,
      destinationPath,
      {},
      (downloadProgress: FileSystem.DownloadProgressData) => {
        const progress =
          downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite;
        onProgress?.(progress);
      },
    );
    this.activeModelDownloads.set(modelName, downloadResumable);
    try {
      // undefined = paused by cancelModelDownload, which removes the destination itself.
      const result = await downloadResumable.downloadAsync();
      // HuggingFace answers a missing file with a 404 HTML page. Saved as the model it breaks every
      // local transcription with a confusing error until the user deletes and re-downloads.
      if (result && (result.status < 200 || result.status >= 300)) {
        await FileSystem.deleteAsync(destinationPath, { idempotent: true });
        throw new Error(
          `Couldn't download the ${modelName} model (HTTP ${result.status}). Please try again.`,
        );
      }
    } finally {
      if (this.activeModelDownloads.get(modelName) === downloadResumable) {
        this.activeModelDownloads.delete(modelName);
      }
    }
  }

  static async cancelModelDownload(modelName: string): Promise<void> {
    const download = this.activeModelDownloads.get(modelName);
    if (!download) return;

    this.activeModelDownloads.delete(modelName);
    try {
      await download.pauseAsync();
    } finally {
      const destinationPath = `${this.getModelsDir()}${modelName}.bin`;
      await FileSystem.deleteAsync(destinationPath, { idempotent: true }).catch(() => undefined);
    }
  }

  static async deleteModel(modelName: string): Promise<void> {
    const models = await this.getAvailableModels();
    const model = models.find((m) => m.name === modelName);

    if (!model || !model.path) {
      throw new Error(`Model "${modelName}" not found`);
    }

    if (this.currentModel === model.path) {
      await this.runExclusive(() => this.releaseContext());
    }

    await FileSystem.deleteAsync(model.path, { idempotent: true });
  }

  static getRecommendedModel(): string {
    return 'base';
  }

  static getModelSize(modelName: string): number {
    const sizes: Record<string, number> = {
      tiny: 75 * 1024 * 1024,
      'tiny.en': 75 * 1024 * 1024,
      base: 142 * 1024 * 1024,
      'base.en': 142 * 1024 * 1024,
      small: 466 * 1024 * 1024,
      'small.en': 466 * 1024 * 1024,
      medium: 1500 * 1024 * 1024,
      'medium.en': 1500 * 1024 * 1024,
      large: 2900 * 1024 * 1024,
    };

    return sizes[modelName] || 0;
  }

  static async cancelTranscription(): Promise<void> {
    await this.runExclusive(() => this.releaseContext());
  }

  static async cleanup(): Promise<void> {
    await this.runExclusive(() => this.releaseContext());
  }
}
