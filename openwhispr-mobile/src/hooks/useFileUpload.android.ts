import { useFileUploadCore } from './useFileUploadCore';
import {
  useAndroidFileUploadLifecycle,
  type AndroidFileUploadOptions,
} from '../android/useAndroidFileUploadLifecycle';
export type { AndroidFileUploadOptions as UseFileUploadOptions } from '../android/useAndroidFileUploadLifecycle';

export function useFileUpload(options: AndroidFileUploadOptions = {}) {
  const { upload, lifecycle } = useFileUploadCore(
    options,
    useAndroidFileUploadLifecycle,
    (text, fileName) => options.onComplete?.(text, fileName),
  );
  return {
    isProcessing: upload.isProcessing,
    currentText: upload.currentText,
    stage: lifecycle.stage,
    cancel: lifecycle.cancel,
    pickAndTranscribeFile: upload.pickAndTranscribeFile,
  };
}
