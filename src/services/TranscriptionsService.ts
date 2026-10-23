import { cloudGet, cloudPost, cloudDelete } from "./cloudApi.js";

interface TranscriptionInput {
  client_transcription_id?: string;
  text: string;
  raw_text?: string | null;
  provider?: string | null;
  model?: string | null;
  language?: string | null;
  audio_duration_ms?: number | null;
  status?: string;
  created_at?: string;
}

interface CloudTranscription {
  id: string;
  client_transcription_id: string | null;
  text: string;
  raw_text: string | null;
  word_count: number;
  source: string;
  provider: string | null;
  model: string | null;
  language: string | null;
  audio_duration_ms: number | null;
  status: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

async function create(
  transcription: TranscriptionInput,
  authGeneration?: number
): Promise<CloudTranscription> {
  return cloudPost<CloudTranscription>("/api/transcriptions/create", transcription, authGeneration);
}

async function batchCreate(
  transcriptions: TranscriptionInput[],
  authGeneration?: number
): Promise<{ created: CloudTranscription[] }> {
  return cloudPost<{ created: CloudTranscription[] }>(
    "/api/transcriptions/batch-create",
    { transcriptions },
    authGeneration
  );
}

async function list(
  limit?: number,
  before?: string,
  since?: string
): Promise<{ transcriptions: CloudTranscription[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (before !== undefined) params.set("before", before);
  if (since !== undefined) params.set("since", since);
  const query = params.toString();
  return cloudGet<{ transcriptions: CloudTranscription[] }>(
    `/api/transcriptions/list${query ? `?${query}` : ""}`
  );
}

async function deleteTranscription(id: string, authGeneration?: number): Promise<void> {
  await cloudDelete("/api/transcriptions/delete", { id }, authGeneration);
}

async function batchDelete(ids: string[], authGeneration?: number): Promise<{ deleted: string[] }> {
  return cloudPost<{ deleted: string[] }>(
    "/api/transcriptions/batch-delete",
    { ids },
    authGeneration
  );
}

export { create, batchCreate, list, deleteTranscription, batchDelete };

export const TranscriptionsService = {
  create,
  batchCreate,
  list,
  delete: deleteTranscription,
  batchDelete,
};
