// How OnboardingFlow wires the "We recommend these settings" step: what the plan
// is built from, and what its Proceed does.
import { buildLocalSetupPlan, type LocalSetupPlan } from "../../config/localSetup";
import { getParakeetModelInfo, getWhisperModelInfo } from "../../models/ModelRegistry";
import type { PolicyDecisionSnapshot } from "../../stores/policyRules";
import type { ComputerProfile } from "../../types/electron";
import {
  activatePendingLocalSetupModel,
  applyLocalSetupSettings,
  rememberPendingLocalSetupRows,
} from "./localSetupSettings";
import type { LocalSetupHandOff } from "./useLocalSetupDownloads";

/**
 * The step's plan, or null while it can't be built yet. A policy still loading
 * or errored fails closed and would offer no rows at all, so it waits for one
 * that has resolved. A guest has no stored languages: the computer's own
 * language stands in. The organisation's first required speech model replaces
 * the step's own dictation pick.
 */
export function planLocalSetup(input: {
  profile: ComputerProfile | null;
  policy: PolicyDecisionSnapshot;
  guest: boolean;
  spokenLanguages: string[];
  requiredModelIds: string[];
}): LocalSetupPlan | null {
  const { profile, policy } = input;
  if (!profile || policy.status === "loading" || policy.status === "error") return null;
  return buildLocalSetupPlan({
    profile,
    spokenLanguages: input.guest ? [] : input.spokenLanguages,
    policy,
    requiredSpeechModelId: input.requiredModelIds.find(
      (id) => getParakeetModelInfo(id) || getWhisperModelInfo(id)
    ),
  });
}

/**
 * Proceed: finishes onboarding and, once nothing can stop the finish, writes the
 * rows whose models are on disk, remembers the ones still downloading, and lets
 * those downloads carry on in the background, each row turning on as it lands.
 */
export async function proceedWithLocalSetup(
  plan: LocalSetupPlan,
  handOff: () => LocalSetupHandOff,
  finish: (beforeComplete: () => void) => Promise<void>,
  settings = {
    apply: applyLocalSetupSettings,
    remember: rememberPendingLocalSetupRows,
    activate: activatePendingLocalSetupModel,
  }
): Promise<void> {
  await finish(() => {
    const { ready, pending, continueInBackground } = handOff();
    settings.apply(plan, ready);
    settings.remember(plan, pending);
    continueInBackground((item) => settings.activate(item.id));
  });
}
