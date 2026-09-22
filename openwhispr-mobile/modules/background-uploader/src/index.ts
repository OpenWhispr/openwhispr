import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

export interface BackgroundUploadOptions {
  url: string;
  fileUri: string;
  fileFieldName?: string;
  fileMimeType?: string;
  fileName?: string;
  parameters?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface BackgroundUploadResult {
  status: number;
  body: string;
  uploadMs?: number;
  bodyBuildMs?: number;
}

interface NativeBackgroundUploader {
  upload(options: {
    url: string;
    fileUri: string;
    fileFieldName: string;
    fileMimeType: string;
    fileName?: string;
    parameters: Record<string, string>;
    headers: Record<string, string>;
    timeoutSeconds?: number;
  }): Promise<BackgroundUploadResult>;
}

const NativeModule: NativeBackgroundUploader | null =
  Platform.OS === 'ios' ? requireNativeModule('BackgroundUploader') : null;

export const BackgroundUploader = {
  isAvailable(): boolean {
    return NativeModule !== null;
  },

  async upload(options: BackgroundUploadOptions): Promise<BackgroundUploadResult> {
    if (!NativeModule) {
      throw new Error('BackgroundUploader is only available on iOS');
    }
    return NativeModule.upload({
      url: options.url,
      fileUri: options.fileUri,
      fileFieldName: options.fileFieldName ?? 'file',
      fileMimeType: options.fileMimeType ?? 'application/octet-stream',
      fileName: options.fileName,
      parameters: options.parameters ?? {},
      headers: options.headers ?? {},
      timeoutSeconds: options.timeoutSeconds,
    });
  },
};
