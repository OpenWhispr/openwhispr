export type InsightsConsentKind = "enable" | "claim";

interface PendingInsightsConsent {
  key: string;
  owner: object;
  promise: Promise<boolean>;
  resolve: (accepted: boolean) => void;
  close: () => void;
}

let pendingConsent: PendingInsightsConsent | null = null;

function settle(consent: PendingInsightsConsent, accepted: boolean, closeDialog = true): void {
  if (pendingConsent !== consent) return;
  pendingConsent = null;
  if (closeDialog) consent.close();
  consent.resolve(accepted);
}

/**
 * Coalesces the consent requested by the Settings, Insights, and Leaderboard
 * hook instances. One account/generation gets one prompt and one answer.
 */
export function requestInsightsConsent({
  accountId,
  authGeneration,
  kind,
  owner,
  open,
  close,
}: {
  accountId: string;
  authGeneration: number;
  kind: InsightsConsentKind;
  owner: object;
  open: (kind: InsightsConsentKind) => void;
  close: () => void;
}): Promise<boolean> {
  const key = JSON.stringify([accountId, authGeneration, kind]);
  if (pendingConsent?.key === key) return pendingConsent.promise;
  if (pendingConsent) settle(pendingConsent, false);

  let resolve!: (accepted: boolean) => void;
  const promise = new Promise<boolean>((answer) => {
    resolve = answer;
  });
  pendingConsent = { key, owner, promise, resolve, close };
  open(kind);
  return promise;
}

export function answerInsightsConsent(owner: object, accepted: boolean): void {
  if (pendingConsent?.owner === owner) settle(pendingConsent, accepted);
}

export function cancelInsightsConsent(owner: object, closeDialog = true): void {
  if (pendingConsent?.owner === owner) settle(pendingConsent, false, closeDialog);
}
