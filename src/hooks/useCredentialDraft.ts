import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionAutoCheck } from "./useConnectionAutoCheck";

type Drafts = Record<string, { value: string; save: (value: string) => void }>;

export interface CredentialCheckReport {
  phase: ConnectionAutoCheck["phase"];
  /** The fields the check's request carries (Corti's region too), with their values. */
  checked: Record<string, string>;
  refused: boolean;
}

const refusalKey = (field: string, request: string, value: string) =>
  JSON.stringify([field, request, value]);

/**
 * Credentials while they are typed. A saved key reaches the main process and every other
 * window, so a panel saves a draft when its field is left (a window switch included) or its
 * check passes; until then it reads the typed value. Each field keeps its own draft.
 *
 * The panel reports its check through `follow`, and an answer settles only drafts that still
 * hold the values the check carried. The fields one check carries are one credential (Corti's
 * ID, secret and tenant): a refusal holds back every typed value it carried, and while any of
 * them is refused none of the credential is saved, until a check of it passes. A field left
 * while its check runs waits for the answer; if the check stops carrying it first (another
 * provider, a hidden panel), no answer is coming, so it is saved as it stands. Closing
 * Settings saves whatever wasn't refused.
 */
export function useCredentialDraft() {
  const [drafts, setDrafts] = useState<Drafts>({});
  // Kept in step with every change and save, ahead of the render that shows them.
  const latest = useRef(drafts);
  const refusals = useRef(new Set<string>());
  // Each field's last answered request and the one it makes now: a value refused in either is
  // held back.
  const answered = useRef<Record<string, string>>({});
  const asking = useRef<Record<string, string>>({});
  // The fields each field was last checked with: one credential.
  const groups = useRef<Record<string, readonly string[]>>({});
  const left = useRef(new Set<string>());
  const carried = useRef<readonly string[]>([]);
  const pending = useRef(false);
  const editing = useRef<string | null>(null);

  // Saves the drafts of `fields`, except those of a credential with a refused draft. With
  // `values`, only drafts that still hold the value an answer was for.
  const settle = useCallback((fields: readonly string[], values?: Record<string, string>) => {
    const refused = (field: string) => {
      const draft = latest.current[field];
      return (
        Boolean(draft) &&
        [answered.current[field], asking.current[field]].some(
          (request) =>
            request !== undefined && refusals.current.has(refusalKey(field, request, draft.value))
        )
      );
    };
    const saved = new Set<Drafts[string]>();
    for (const field of fields) {
      const draft = latest.current[field];
      if (!draft || (values && draft.value !== values[field])) continue;
      if ((groups.current[field] ?? [field]).some(refused)) continue;
      draft.save(draft.value);
      saved.add(draft);
      left.current.delete(field);
    }
    if (saved.size === 0) return;
    const keep = (current: Drafts) =>
      Object.fromEntries(Object.entries(current).filter(([, draft]) => !saved.has(draft)));
    latest.current = keep(latest.current);
    setDrafts(keep);
  }, []);

  // Unmounting fires no blur, as when Escape closes Settings.
  useEffect(() => () => settle(Object.keys(latest.current)), [settle]);

  const save = useCallback(() => {
    const field = editing.current;
    // The field typed in last may have been saved since; leaving it again marks nothing.
    if (!field || !latest.current[field]) return;
    left.current.add(field);
    if (!(pending.current && carried.current.includes(field))) settle([field]);
  }, [settle]);

  const follow = useCallback(
    ({ phase, checked, refused }: CredentialCheckReport) => {
      const now = phase === "idle" ? [] : Object.keys(checked);
      const dropped = carried.current.filter((field) => !now.includes(field));
      carried.current = now;
      const request = JSON.stringify(checked);
      for (const field of now) {
        asking.current[field] = request;
        groups.current[field] = now;
      }
      pending.current = phase === "waiting" || phase === "checking";
      settle(dropped.filter((field) => left.current.has(field)));
      if (pending.current || phase === "idle") return;
      for (const field of now) {
        answered.current[field] = request;
        const key = refusalKey(field, request, checked[field]);
        if (refused && checked[field] && latest.current[field]?.value === checked[field]) {
          refusals.current.add(key);
        } else if (phase === "connected") {
          refusals.current.delete(key);
        }
      }
      // A pass saves every field it carried; any other answer saves them once one was left.
      const leftOne = now.some((field) => left.current.has(field));
      settle(phase === "connected" || leftOne ? now : [], checked);
    },
    [settle]
  );

  return {
    value: (field: string, saved: string) => drafts[field]?.value ?? saved,
    change: (field: string, value: string, save: (value: string) => void) => {
      editing.current = field;
      left.current.delete(field);
      const draft = { value, save };
      latest.current = { ...latest.current, [field]: draft };
      setDrafts((current) => ({ ...current, [field]: draft }));
    },
    save,
    follow,
  };
}
