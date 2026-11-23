import { create } from 'zustand';

/**
 * Figma R2b: on Cloud, Stop and save opens the note at once while the last words save. The
 * recording screen keeps finishing in the background and reports here; the note's Summary card
 * reads it. `saving` = the stream's last words, `finishing` = transcript stored, title and summary
 * being written, `failed` = the save threw (the recording is kept; `retry` runs it again).
 */
export type CloudFinishStage = 'saving' | 'finishing' | 'failed';
type Job = { stage: CloudFinishStage; retry?: () => void };

export const useCloudFinish = create<{ jobs: Record<number, Job> }>(() => ({ jobs: {} }));

export function setCloudFinish(noteId: number, job: Job | null) {
  useCloudFinish.setState((state) => {
    const jobs = { ...state.jobs };
    if (job) jobs[noteId] = job;
    else delete jobs[noteId];
    return { jobs };
  });
}

export function useCloudFinishJob(noteId: number | null | undefined): Job | null {
  return useCloudFinish((state) => (noteId != null ? (state.jobs[noteId] ?? null) : null));
}
