import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";
import type {
  CloudSharedEntry,
  CloudSharedHide,
  SharedDictionaryHidesResponse,
  SharedDictionaryListResponse,
  SharedDictionaryPage,
  SharedDictionaryShareInput,
  SharedDictionaryShareResponse,
} from "../types/sharedDictionary";

// The API rejects larger batches; chunking and partial results belong to the
// actions layer, so the client refuses before sending anything.
export const MAX_SHARED_DICTIONARY_BATCH = 200;
// Lists one share may target.
export const MAX_SHARED_DICTIONARY_TARGETS = 20;

function assertBatchSize(count: number, label: string): void {
  if (count > MAX_SHARED_DICTIONARY_BATCH) {
    throw new RangeError(
      `Shared dictionary accepts at most ${MAX_SHARED_DICTIONARY_BATCH} ${label} per request`
    );
  }
}

function buildPageQuery(workspaceId: string, page: SharedDictionaryPage): string {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  if (page.since) params.set("since", page.since);
  if (page.sinceId) params.set("since_id", page.sinceId);
  if (page.cursor) params.set("cursor", page.cursor);
  if (page.cursorId) params.set("cursor_id", page.cursorId);
  if (page.limit) params.set("limit", String(page.limit));
  return params.toString();
}

async function list(
  workspaceId: string,
  page: SharedDictionaryPage
): Promise<SharedDictionaryListResponse> {
  return cloudGet<SharedDictionaryListResponse>(
    `/api/shared-dictionary/list?${buildPageQuery(workspaceId, page)}`
  );
}

async function hides(
  workspaceId: string,
  page: SharedDictionaryPage
): Promise<SharedDictionaryHidesResponse> {
  return cloudGet<SharedDictionaryHidesResponse>(
    `/api/shared-dictionary/hides?${buildPageQuery(workspaceId, page)}`
  );
}

async function create(
  workspaceId: string,
  spaceId: string | null,
  words: string[]
): Promise<{ created: CloudSharedEntry[]; alreadyPresent: string[] }> {
  assertBatchSize(words.length, "words");
  // space_id must be sent even when null: the API treats an absent key as invalid.
  return cloudPost<{ created: CloudSharedEntry[]; alreadyPresent: string[] }>(
    "/api/shared-dictionary/create",
    { workspace_id: workspaceId, space_id: spaceId, words }
  );
}

async function update(workspaceId: string, id: string, word: string): Promise<CloudSharedEntry> {
  return cloudPatch<CloudSharedEntry>("/api/shared-dictionary/update", {
    workspace_id: workspaceId,
    id,
    word,
  });
}

async function remove(workspaceId: string, ids: string[]): Promise<{ deletedIds: string[] }> {
  assertBatchSize(ids.length, "ids");
  return cloudDelete<{ deletedIds: string[] }>("/api/shared-dictionary/delete", {
    workspace_id: workspaceId,
    ids,
  });
}

async function restore(
  workspaceId: string,
  ids: string[]
): Promise<{ restored: CloudSharedEntry[]; conflicts: string[] }> {
  assertBatchSize(ids.length, "ids");
  return cloudPost<{ restored: CloudSharedEntry[]; conflicts: string[] }>(
    "/api/shared-dictionary/restore",
    { workspace_id: workspaceId, ids }
  );
}

async function share(
  workspaceId: string,
  input: SharedDictionaryShareInput
): Promise<SharedDictionaryShareResponse> {
  assertBatchSize(input.personal.length + input.words.length, "words");
  if (input.targets.length > MAX_SHARED_DICTIONARY_TARGETS) {
    throw new RangeError(
      `Shared dictionary shares to at most ${MAX_SHARED_DICTIONARY_TARGETS} lists per request`
    );
  }
  return cloudPost<SharedDictionaryShareResponse>("/api/shared-dictionary/share", {
    workspace_id: workspaceId,
    targets: input.targets,
    personal: input.personal,
    words: input.words,
  });
}

async function hide(
  workspaceId: string,
  ids: string[],
  hidden: boolean
): Promise<{ hides: CloudSharedHide[] }> {
  assertBatchSize(ids.length, "ids");
  return cloudPost<{ hides: CloudSharedHide[] }>("/api/shared-dictionary/hide", {
    workspace_id: workspaceId,
    ids,
    hidden,
  });
}

export const SharedDictionaryService = {
  list,
  hides,
  create,
  update,
  remove,
  restore,
  share,
  hide,
};
