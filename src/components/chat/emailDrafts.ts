import type { ToolCallInfo } from "./types";

export interface EmailDraftCardData {
  callId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  from: string;
  sent: boolean;
}

export function parseRecipients(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Email draft cards rendered under an assistant message, one per completed
// draft_email call whose metadata survived transport.
export function extractEmailDrafts(toolCalls?: ToolCallInfo[]): EmailDraftCardData[] {
  if (!toolCalls) return [];
  const drafts: EmailDraftCardData[] = [];
  for (const tc of toolCalls) {
    if (tc.name !== "draft_email" || tc.status !== "completed") continue;
    const m = tc.metadata;
    if (!m || Array.isArray(m)) continue;
    if (typeof m.subject !== "string" || typeof m.body !== "string") continue;
    drafts.push({
      callId: tc.id,
      to: Array.isArray(m.to) ? m.to.map(String) : [],
      cc: Array.isArray(m.cc) ? m.cc.map(String) : [],
      subject: m.subject,
      body: m.body,
      from: typeof m.from === "string" ? m.from : "",
      sent: m.status === "sent",
    });
  }
  return drafts;
}
