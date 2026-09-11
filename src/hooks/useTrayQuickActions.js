import { useEffect } from "react";
import { resolveTrayAssistantAction, resolveTrayMeetingAction } from "../helpers/trayActionPolicy";

/**
 * The tray's quick actions, answered by the one renderer that owns the policy and
 * recording state the pill's command menu gates them on.
 *
 * The pill menu hides an item it cannot run; the tray always shows it, so every
 * path here either acts or explains itself through `refuse` — a tray click never
 * just disappears.
 */
export function useTrayQuickActions({
  agentAllowed,
  meetingAllowed,
  policyResolved,
  isRecording,
  liveTranscriptMounted,
  closeCommandMenu,
  openAssistantPanel,
  refuse,
}) {
  // Main holds the meeting entry on its own path until this lands: before the
  // listeners below exist, anything it sends this window goes nowhere.
  useEffect(() => {
    window.electronAPI?.notifyDictationRendererReady?.();
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onOpenAssistantPanel?.(() => {
      closeCommandMenu();
      const decision = resolveTrayAssistantAction({
        agentAllowed,
        policyResolved,
        isRecording,
        liveTranscriptMounted,
      });
      if (decision.action === "refuse") {
        refuse(decision.messageKey);
        return;
      }
      void openAssistantPanel();
    });
    return () => unsubscribe?.();
  }, [
    agentAllowed,
    policyResolved,
    isRecording,
    liveTranscriptMounted,
    closeCommandMenu,
    openAssistantPanel,
    refuse,
  ]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onStartMeeting?.(() => {
      closeCommandMenu();
      const decision = resolveTrayMeetingAction({ meetingAllowed, policyResolved, isRecording });
      if (decision.action === "refuse") {
        refuse(decision.messageKey);
        return;
      }
      void window.electronAPI?.startManualMeeting?.();
    });
    return () => unsubscribe?.();
  }, [meetingAllowed, policyResolved, isRecording, closeCommandMenu, refuse]);

  // Main refuses on the gates only it can see — a panel owning the pill, a
  // transcription still settling, a hotkey being captured — and says so here.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onTrayActionRefused?.((data) => {
      if (data?.messageKey) refuse(data.messageKey);
    });
    return () => unsubscribe?.();
  }, [refuse]);
}
