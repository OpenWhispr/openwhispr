import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation } from '../../modules/android-dictation/src';
import { create } from 'zustand';
import i18n from './strings';
import { withAndroidInference } from './inferenceQueue';
import { MOONSHINE_MODELS } from './moonshineModels';
import { Platform } from 'react-native';
import { MEETING_MODELS } from './meetingModels';

export const ANDROID_MODELS = {
  ...MOONSHINE_MODELS,
  ...MEETING_MODELS,
  'parakeet-v3': {
    title: 'Parakeet v3',
    kind: 'speech',
    bytes: 670478772,
    files: [
      {
        name: 'encoder.int8.onnx',
        bytes: 652184281,
        sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247',
      },
      {
        name: 'decoder.int8.onnx',
        bytes: 11845275,
        sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e',
      },
      {
        name: 'joiner.int8.onnx',
        bytes: 6355277,
        sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3',
      },
      {
        name: 'tokens.txt',
        bytes: 93939,
        sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d',
      },
    ],
  },
  'qwen-small': {
    title: 'Qwen 0.5B',
    kind: 'text',
    bytes: 491400032,
    sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/qwen2.5-0.5b-instruct-q4_k_m.gguf',
  },
  'qwen-balanced': {
    title: 'Qwen3 1.7B',
    kind: 'text',
    bytes: 1107409472,
    sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_K_M.gguf',
  },
} as const;
export type AndroidModelId = keyof typeof ANDROID_MODELS;
export function modelSupported(id: AndroidModelId): boolean {
  return !id.startsWith('moonshine-') || Number(Platform.Version) >= 26;
}
export const useModelDownloads = create<{ progress: Partial<Record<AndroidModelId, number>> }>(
  () => ({ progress: {} }),
);
function publishProgress(id: AndroidModelId, fraction?: number) {
  useModelDownloads.setState((state) => {
    const progress = { ...state.progress };
    if (fraction === undefined) delete progress[id];
    else progress[id] = fraction;
    return { progress };
  });
}
const active = new Map<
  AndroidModelId,
  { download?: FileSystem.DownloadResumable; cancelled: boolean }
>();
const verifiedFiles = new Map<string, { modified: number; sha256: string }>();
export function modelPath(id: AndroidModelId): string {
  return `${FileSystem.documentDirectory}android-models/${id}${ANDROID_MODELS[id].kind === 'text' ? '.gguf' : ''}`;
}
function filesFor(id: AndroidModelId) {
  if (id === 'parakeet-v3')
    return ANDROID_MODELS[id].files.map((file) => ({
      ...file,
      url: `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/${file.name}`,
      destination: `${modelPath(id)}/${file.name}`,
    }));
  const model = ANDROID_MODELS[id];
  if ('files' in model)
    return model.files.map((file) => ({ ...file, destination: `${modelPath(id)}/${file.name}` }));
  return [{ ...model, destination: modelPath(id) }];
}
export async function modelReady(id: AndroidModelId): Promise<boolean> {
  if (!(id in ANDROID_MODELS) || !modelSupported(id)) return false;
  for (const file of filesFor(id)) {
    const info = await FileSystem.getInfoAsync(file.destination);
    if (!info.exists || info.isDirectory || info.size !== file.bytes) return false;
    const cached = verifiedFiles.get(file.destination);
    if (cached?.modified === info.modificationTime && cached?.sha256 === file.sha256) continue;
    if ((await AndroidDictation!.sha256(file.destination)) !== file.sha256) {
      verifiedFiles.delete(file.destination);
      return false;
    }
    verifiedFiles.set(file.destination, { modified: info.modificationTime, sha256: file.sha256 });
  }
  return true;
}
export async function downloadAndroidModel(
  id: AndroidModelId,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  if (!modelSupported(id)) throw new Error(i18n.t('moonshineAndroidVersion'));
  if (active.has(id)) throw new Error(i18n.t('downloadBusy'));
  const job: { download?: FileSystem.DownloadResumable; cancelled: boolean } = { cancelled: false };
  active.set(id, job);
  const progress = (fraction: number) => {
    publishProgress(id, fraction);
    onProgress?.(fraction);
  };
  progress(0);
  let completed = 0;
  try {
    for (const file of filesFor(id)) {
      if (job.cancelled) throw new Error(i18n.t('downloadCancelled'));
      const existing = await FileSystem.getInfoAsync(file.destination);
      if (
        existing.exists &&
        !existing.isDirectory &&
        existing.size === file.bytes &&
        (await AndroidDictation!.sha256(file.destination)) === file.sha256
      ) {
        completed += file.bytes;
        progress(completed / ANDROID_MODELS[id].bytes);
        continue;
      }
      verifiedFiles.delete(file.destination);
      if ((await FileSystem.getFreeDiskStorageAsync()) < file.bytes * 1.15)
        throw new Error(i18n.t('downloadStorage'));
      await FileSystem.makeDirectoryAsync(
        file.destination.slice(0, file.destination.lastIndexOf('/')),
        { intermediates: true },
      );
      const temporary = `${file.destination}.part`;
      try {
        job.download = FileSystem.createDownloadResumable(file.url, temporary, {}, (event) =>
          progress(
            Math.min(0.98, (completed + event.totalBytesWritten) / ANDROID_MODELS[id].bytes),
          ),
        );
        const response = await job.download.downloadAsync();
        if (job.cancelled || !response) throw new Error(i18n.t('downloadCancelled'));
        if (response.status !== 200)
          throw new Error(i18n.t('downloadFailed', { status: response.status }));
        const info = await FileSystem.getInfoAsync(temporary);
        if (
          !info.exists ||
          info.isDirectory ||
          info.size !== file.bytes ||
          (await AndroidDictation!.sha256(temporary)) !== file.sha256
        )
          throw new Error(i18n.t('downloadVerification'));
        if (job.cancelled) throw new Error(i18n.t('downloadCancelled'));
        await FileSystem.moveAsync({ from: temporary, to: file.destination });
        completed += file.bytes;
        progress(completed / ANDROID_MODELS[id].bytes);
      } finally {
        job.download = undefined;
        await FileSystem.deleteAsync(temporary, { idempotent: true });
      }
    }
  } finally {
    active.delete(id);
    publishProgress(id);
  }
}
export async function cancelAndroidDownload(id: AndroidModelId): Promise<void> {
  const job = active.get(id);
  if (!job) return;
  job.cancelled = true;
  await job.download?.pauseAsync();
}

export async function removeAndroidModel(id: AndroidModelId): Promise<void> {
  if (active.has(id)) throw new Error(i18n.t('downloadBusy'));
  await withAndroidInference(async () => {
    const { LocalTextModel } = await import('./LocalTextModel');
    await LocalTextModel.release();
    await AndroidDictation!.releaseParakeet();
    await AndroidDictation!.releaseMoonshine();
    for (const file of filesFor(id)) verifiedFiles.delete(file.destination);
    await FileSystem.deleteAsync(modelPath(id), { idempotent: true });
  });
}
