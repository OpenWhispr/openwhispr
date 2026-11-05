import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";
import type { CloudSkillEntry, CloudSkillFile, CloudSkillMeta } from "../types/skills";

interface SkillEntryInput {
  name: string;
  enabled: boolean;
  content_hash: string;
  files: CloudSkillFile[];
  client_skill_id?: string | null;
  created_at?: string;
}

type SkillPage = { entries: CloudSkillEntry[]; hasMore: boolean };

async function batchCreate(entries: SkillEntryInput[]): Promise<{ created: CloudSkillMeta[] }> {
  return cloudPost<{ created: CloudSkillMeta[] }>("/api/skills/batch-create", { entries });
}

async function update(
  id: string,
  updates: { enabled: boolean; content_hash: string; files: CloudSkillFile[] }
): Promise<CloudSkillMeta> {
  return cloudPatch<CloudSkillMeta>("/api/skills/update", { id, ...updates });
}

async function deleteEntry(id: string): Promise<void> {
  await cloudDelete("/api/skills/delete", { id });
}

function listQuery(keys: [string, string], value?: string, limit?: number, id?: string): string {
  const params = new URLSearchParams();
  if (value) params.set(keys[0], value);
  if (id) params.set(keys[1], id);
  if (limit) params.set("limit", String(limit));
  return params.toString() ? `?${params}` : "";
}

async function listSnapshot(
  cursor?: string,
  limit?: number,
  cursorId?: string
): Promise<SkillPage> {
  return cloudGet<SkillPage>(
    `/api/skills/list${listQuery(["cursor", "cursor_id"], cursor, limit, cursorId)}`
  );
}

async function listDelta(since?: string, limit?: number, sinceId?: string): Promise<SkillPage> {
  return cloudGet<SkillPage>(
    `/api/skills/list${listQuery(["since", "since_id"], since, limit, sinceId)}`
  );
}

export const SkillsService = {
  batchCreate,
  update,
  delete: deleteEntry,
  listSnapshot,
  listDelta,
};
