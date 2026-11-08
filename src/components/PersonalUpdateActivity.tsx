import { useEffect } from "react";
import { useMeetingRecordingStore } from "../stores/meetingRecordingStore";
import { useBatchQueueStore } from "../stores/batchQueueStore";
import { useActionProcessingStore } from "../stores/actionProcessingStore";

// Report on every state transition as well as periodically. A missing heartbeat
// prevents the main process from restarting a stalled or loading renderer.
export default function PersonalUpdateActivity() {
  useEffect(() => {
    const report = () => {
      const meeting = useMeetingRecordingStore.getState();
      const batch = useBatchQueueStore.getState();
      const actions = useActionProcessingStore.getState();
      window.electronAPI?.reportUpdateActivity?.(
        meeting.isRecording ||
          meeting.isTranscribing ||
          batch.isProcessing ||
          batch.queue.some(
            (item) => item.status === "downloading" || item.status === "transcribing"
          ) ||
          Object.values(actions.noteStates).some((state) => state.status === "processing")
      );
    };
    const unsubscribers = [
      useMeetingRecordingStore.subscribe(report),
      useBatchQueueStore.subscribe(report),
      useActionProcessingStore.subscribe(report),
    ];
    report();
    const timer = setInterval(report, 5000);
    return () => {
      clearInterval(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      window.electronAPI?.reportUpdateActivity?.(true);
    };
  }, []);
  return null;
}
