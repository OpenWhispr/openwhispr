import { SpeakerDiarization } from '../../../modules/speaker-diarization/src';
import type { Diarizer, DiarizationResult, DiarSegment } from './diarizer';

export const FluidAudioDiarizer: Diarizer = {
  isAvailable: () => SpeakerDiarization.isAvailable(),
  isModelDownloaded: () => SpeakerDiarization.isModelDownloaded(),
  // The native module exposes no download progress, so the Diarizer's onProgress is unused here.
  downloadModel: () => SpeakerDiarization.downloadModel(),
  deleteModel: () => SpeakerDiarization.deleteModel(),
  async diarize(wavUri: string, numberOfSpeakers = 0): Promise<DiarizationResult> {
    const raw = await SpeakerDiarization.diarize(wavUri, numberOfSpeakers);

    // Map FluidAudio string speakerIds -> stable 0-based numbers (M0 logic).
    const idMap = new Map<string, number>();
    const idFor = (label: string): number => {
      const existing = idMap.get(label);
      if (existing !== undefined) return existing;
      const next = idMap.size;
      idMap.set(label, next);
      return next;
    };
    const segments: DiarSegment[] = raw.segments.map((s) => ({
      start: s.startTime,
      end: s.endTime,
      speakerId: idFor(s.speakerId),
    }));

    const embeddings: Record<number, number[]> = {};
    if (raw.speakerDatabase && Object.keys(raw.speakerDatabase).length > 0) {
      for (const [label, vec] of Object.entries(raw.speakerDatabase))
        embeddings[idFor(label)] = vec;
    } else {
      const acc: Record<number, { sum: number[]; count: number }> = {};
      for (const s of raw.segments) {
        const id = idFor(s.speakerId);
        const emb = s.embedding;
        const b = acc[id];
        if (!b) acc[id] = { sum: [...emb], count: 1 };
        else {
          for (let i = 0; i < emb.length; i++) b.sum[i] = (b.sum[i] ?? 0) + emb[i];
          b.count += 1;
        }
      }
      for (const [id, { sum, count }] of Object.entries(acc))
        embeddings[Number(id)] = sum.map((x) => x / count);
    }

    return { speakerCount: idMap.size, segments, embeddings };
  },
};
